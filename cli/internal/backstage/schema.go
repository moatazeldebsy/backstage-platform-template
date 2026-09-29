package backstage

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Param is one scaffolder template parameter, as declared in spec.parameters.
type Param struct {
	Title       string
	Description string
	Type        string
	Enum        []any
	Default     any
}

// branch is one arm of a JSON Schema `dependencies.<key>.oneOf` block — the
// shape the templates use for "new repo vs existing repo" style choices.
type branch struct {
	props    map[string]Param
	required []string
}

// TemplateSchema is the flattened parameter schema of a scaffolder template.
// Templates split parameters across form pages; this merges them.
type TemplateSchema struct {
	Props    map[string]Param
	Required []string
	deps     map[string][]branch
}

// ParseTemplateSchema flattens spec.parameters (a list of pages, or a single
// page) as decoded from either the catalog JSON API or template.yaml.
func ParseTemplateSchema(parameters any) *TemplateSchema {
	s := &TemplateSchema{Props: map[string]Param{}, deps: map[string][]branch{}}
	var pages []any
	switch p := parameters.(type) {
	case []any:
		pages = p
	case map[string]any:
		pages = []any{p}
	}
	for _, raw := range pages {
		page, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for k, v := range parseProps(page["properties"]) {
			s.Props[k] = v
		}
		s.Required = append(s.Required, toStrings(page["required"])...)
		deps, _ := page["dependencies"].(map[string]any)
		for key, d := range deps {
			dm, _ := d.(map[string]any)
			oneOf, _ := dm["oneOf"].([]any)
			for _, o := range oneOf {
				om, _ := o.(map[string]any)
				s.deps[key] = append(s.deps[key], branch{
					props:    parseProps(om["properties"]),
					required: toStrings(om["required"]),
				})
			}
		}
	}
	return s
}

func parseProps(raw any) map[string]Param {
	out := map[string]Param{}
	m, _ := raw.(map[string]any)
	for k, v := range m {
		pm, _ := v.(map[string]any)
		p := Param{Default: pm["default"]}
		p.Title, _ = pm["title"].(string)
		p.Description, _ = pm["description"].(string)
		p.Type, _ = pm["type"].(string)
		p.Enum, _ = pm["enum"].([]any)
		out[k] = p
	}
	return out
}

func toStrings(raw any) []string {
	l, _ := raw.([]any)
	out := make([]string, 0, len(l))
	for _, v := range l {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Declared reports whether key is a parameter anywhere in the template,
// including inside a conditional (dependencies.oneOf) branch.
func (s *TemplateSchema) Declared(key string) bool {
	if _, ok := s.Props[key]; ok {
		return true
	}
	for _, branches := range s.deps {
		for _, b := range branches {
			if _, ok := b.props[key]; ok {
				return true
			}
		}
	}
	return false
}

// Filter returns only the values the template declares, plus the sorted keys it dropped.
func (s *TemplateSchema) Filter(values map[string]any) (map[string]any, []string) {
	kept := map[string]any{}
	var dropped []string
	for k, v := range values {
		if s.Declared(k) {
			kept[k] = v
		} else {
			dropped = append(dropped, k)
		}
	}
	sort.Strings(dropped)
	return kept, dropped
}

// Missing returns the sorted required keys absent from values — the
// top-level ones plus those of whichever conditional branch the values select.
// Backstage rejects a task with any of these missing, even when the
// parameter declares a default (defaults are only applied by the web form).
func (s *TemplateSchema) Missing(values map[string]any) []string {
	var missing []string
	check := func(keys []string) {
		for _, k := range keys {
			if !present(values[k]) {
				missing = append(missing, k)
			}
		}
	}
	check(s.Required)
	for key, branches := range s.deps {
		v, ok := values[key]
		if !ok {
			v = s.Props[key].Default
		}
		for _, b := range branches {
			if b.selects(key, v) {
				check(b.required)
				break
			}
		}
	}
	sort.Strings(missing)
	return dedupe(missing)
}

// selects reports whether this branch applies when the dependency key has value v.
// A branch without an enum on the key never matches (it can't be selected by value).
func (b branch) selects(key string, v any) bool {
	p, ok := b.props[key]
	if !ok || v == nil {
		return false
	}
	for _, e := range p.Enum {
		if fmt.Sprint(e) == fmt.Sprint(v) {
			return true
		}
	}
	return false
}

func present(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	}
	return true
}

func dedupe(sorted []string) []string {
	out := sorted[:0]
	for i, s := range sorted {
		if i == 0 || s != sorted[i-1] {
			out = append(out, s)
		}
	}
	return out
}

// Coerce converts string values (from --set) to the type the template
// declares, so `--set vus=50` is sent as a number, not "50". Non-string
// values and undeclared keys are left alone.
func (s *TemplateSchema) Coerce(values map[string]any) error {
	for k, v := range values {
		str, ok := v.(string)
		if !ok {
			continue
		}
		var err error
		switch s.typeOf(k) {
		case "integer":
			values[k], err = strconv.Atoi(str)
		case "number":
			values[k], err = strconv.ParseFloat(str, 64)
		case "boolean":
			values[k], err = strconv.ParseBool(str)
		case "array":
			if strings.HasPrefix(strings.TrimSpace(str), "[") {
				var arr []any
				err = json.Unmarshal([]byte(str), &arr)
				values[k] = arr
			} else {
				var arr []string
				for _, p := range strings.Split(str, ",") {
					if p = strings.TrimSpace(p); p != "" {
						arr = append(arr, p)
					}
				}
				values[k] = arr
			}
		case "object":
			var obj map[string]any
			err = json.Unmarshal([]byte(str), &obj)
			values[k] = obj
		}
		if err != nil {
			return fmt.Errorf("parameter %q: cannot convert %q to %s: %w", k, str, s.typeOf(k), err)
		}
	}
	return nil
}

// typeOf returns the declared JSON Schema type of key, searching conditional branches too.
func (s *TemplateSchema) typeOf(key string) string {
	if p, ok := s.Props[key]; ok {
		return p.Type
	}
	for _, branches := range s.deps {
		for _, b := range branches {
			if p, ok := b.props[key]; ok {
				return p.Type
			}
		}
	}
	return ""
}
