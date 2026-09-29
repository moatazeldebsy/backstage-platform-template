package backstage

import (
	"reflect"
	"testing"
)

// suiteParams mirrors the shape of the test-suite templates: two form pages,
// with repoUrl / targetRepoUrl selected by deploymentMode.
func suiteParams() any {
	return []any{
		map[string]any{
			"required": []any{"name", "owner"},
			"properties": map[string]any{
				"name":  map[string]any{"type": "string"},
				"owner": map[string]any{"type": "string"},
				"vus":   map[string]any{"type": "integer", "default": 10},
			},
		},
		map[string]any{
			"properties": map[string]any{
				"deploymentMode": map[string]any{
					"type": "string", "enum": []any{"new-repository", "add-to-existing"}, "default": "new-repository",
				},
				"containers": map[string]any{"type": "array"},
				"strict":     map[string]any{"type": "boolean"},
			},
			"dependencies": map[string]any{
				"deploymentMode": map[string]any{
					"oneOf": []any{
						map[string]any{
							"properties": map[string]any{
								"deploymentMode": map[string]any{"enum": []any{"new-repository"}},
								"repoUrl":        map[string]any{"type": "string"},
							},
							"required": []any{"repoUrl"},
						},
						map[string]any{
							"properties": map[string]any{
								"deploymentMode": map[string]any{"enum": []any{"add-to-existing"}},
								"targetRepoUrl":  map[string]any{"type": "string"},
							},
							"required": []any{"targetRepoUrl"},
						},
					},
				},
			},
		},
	}
}

func TestParseTemplateSchema_SinglePage(t *testing.T) {
	s := ParseTemplateSchema(map[string]any{
		"required":   []any{"name"},
		"properties": map[string]any{"name": map[string]any{"type": "string", "title": "Name"}},
	})
	if s.Props["name"].Title != "Name" || !reflect.DeepEqual(s.Required, []string{"name"}) {
		t.Errorf("unexpected schema: %+v", s)
	}
}

func TestDeclaredIncludesConditionalBranches(t *testing.T) {
	s := ParseTemplateSchema(suiteParams())
	for _, k := range []string{"name", "deploymentMode", "repoUrl", "targetRepoUrl"} {
		if !s.Declared(k) {
			t.Errorf("%s should be declared", k)
		}
	}
	if s.Declared("namespace") {
		t.Error("namespace should not be declared")
	}
}

func TestFilter(t *testing.T) {
	s := ParseTemplateSchema(suiteParams())
	kept, dropped := s.Filter(map[string]any{"name": "a", "namespace": "x", "cloudGrid": "none"})
	if !reflect.DeepEqual(kept, map[string]any{"name": "a"}) {
		t.Errorf("kept = %v", kept)
	}
	if !reflect.DeepEqual(dropped, []string{"cloudGrid", "namespace"}) {
		t.Errorf("dropped = %v", dropped)
	}
}

func TestMissing(t *testing.T) {
	s := ParseTemplateSchema(suiteParams())
	cases := []struct {
		name   string
		values map[string]any
		want   []string
	}{
		{"greenfield complete", map[string]any{"name": "a", "owner": "o", "deploymentMode": "new-repository", "repoUrl": "r"}, nil},
		{"brownfield needs targetRepoUrl", map[string]any{"name": "a", "owner": "o", "deploymentMode": "add-to-existing", "repoUrl": "r"}, []string{"targetRepoUrl"}},
		{"branch picked from default", map[string]any{"name": "a", "owner": "o"}, []string{"repoUrl"}},
		{"empty string counts as missing", map[string]any{"name": "", "owner": "o", "repoUrl": "r"}, []string{"name"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := s.Missing(tc.values)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Missing = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCoerce(t *testing.T) {
	s := ParseTemplateSchema(suiteParams())
	v := map[string]any{"vus": "50", "containers": "postgres, redis", "strict": "true", "name": "42", "undeclared": "7"}
	if err := s.Coerce(v); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"vus": 50, "containers": []string{"postgres", "redis"}, "strict": true, "name": "42", "undeclared": "7"}
	if !reflect.DeepEqual(v, want) {
		t.Errorf("Coerce = %#v, want %#v", v, want)
	}
	if err := s.Coerce(map[string]any{"vus": "lots"}); err == nil {
		t.Error("expected error converting non-integer")
	}
}
