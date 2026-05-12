package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleRoot(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handleRoot(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
}

func TestHandleLiveness(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	handleLiveness(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
}
