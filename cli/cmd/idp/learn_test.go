package main

import "testing"

func TestTipsNonEmpty(t *testing.T) {
	if len(tips) == 0 {
		t.Fatal("tips list is empty")
	}
	for i, tip := range tips {
		if tip == "" {
			t.Errorf("tips[%d] is empty", i)
		}
	}
}

func TestRunTip_Deterministic(t *testing.T) {
	tipSeed = 42
	defer func() { tipSeed = 0 }()

	if err := runTip(nil, nil); err != nil {
		t.Fatalf("runTip returned error: %v", err)
	}
}

func TestLearnResourcesKnownKinds(t *testing.T) {
	for _, kind := range []string{"component", "template", "group"} {
		resources, ok := learnResources[kind]
		if !ok {
			t.Errorf("learnResources missing kind %q", kind)
		}
		if len(resources) == 0 {
			t.Errorf("learnResources[%q] is empty", kind)
		}
	}
}

func TestRunLearn_UnknownType(t *testing.T) {
	learnType = "bogus"
	defer func() { learnType = "component" }()

	if err := runLearn(nil, nil); err == nil {
		t.Error("expected error for unknown --type")
	}
}

func TestRunLearn_KnownTypeNoName(t *testing.T) {
	learnType = "component"
	learnName = ""
	if err := runLearn(nil, nil); err != nil {
		t.Errorf("runLearn returned error: %v", err)
	}
}
