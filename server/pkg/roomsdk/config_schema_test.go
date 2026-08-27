package roomsdk

import (
	"errors"
	"testing"
)

func TestConfigSchemaEnforcesBoundedEnumeratedStrings(t *testing.T) {
	schema := []byte(`{
  "type":"object",
  "properties":{
    "text":{"type":"string","minLength":1,"maxLength":5},
    "style":{"type":"string","enum":["bubble","neon"]},
    "color":{"type":"string","pattern":"^#[0-9A-Fa-f]{6}$"}
  },
  "required":["text","style","color"],
  "additionalProperties":false
}`)

	for name, config := range map[string][]byte{
		"empty text":    []byte(`{"text":"","style":"bubble","color":"#aabbcc"}`),
		"long text":     []byte(`{"text":"123456","style":"bubble","color":"#aabbcc"}`),
		"unknown style": []byte(`{"text":"ok","style":"plain","color":"#aabbcc"}`),
		"invalid color": []byte(`{"text":"ok","style":"neon","color":"red"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateConfigJSON(schema, config); err == nil {
				t.Fatal("invalid config was accepted")
			}
		})
	}

	if err := validateConfigJSON(
		schema,
		[]byte(`{"text":"paint","style":"neon","color":"#A1b2C3"}`),
	); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestConfigSchemaEnforcesAuthoredNumericAndCollectionConstraints(t *testing.T) {
	schema := []byte(`{
  "type":"object",
  "properties":{
    "strength":{"type":"number","minimum":0,"maximum":10},
    "radius":{"type":"number","exclusiveMinimum":0,"exclusiveMaximum":5},
    "allowedKinds":{
      "type":"array",
      "items":{"type":"string","enum":["avatar","item"]},
      "minItems":1,
      "maxItems":2,
      "uniqueItems":true
    }
  },
  "required":["strength","radius","allowedKinds"],
  "additionalProperties":false
}`)

	for name, config := range map[string][]byte{
		"below minimum":        []byte(`{"strength":-0.01,"radius":1,"allowedKinds":["avatar"]}`),
		"above maximum":        []byte(`{"strength":10.01,"radius":1,"allowedKinds":["avatar"]}`),
		"at exclusive minimum": []byte(`{"strength":1,"radius":0,"allowedKinds":["avatar"]}`),
		"at exclusive maximum": []byte(`{"strength":1,"radius":5,"allowedKinds":["avatar"]}`),
		"too few items":        []byte(`{"strength":1,"radius":1,"allowedKinds":[]}`),
		"too many items":       []byte(`{"strength":1,"radius":1,"allowedKinds":["avatar","item","avatar"]}`),
		"duplicate items":      []byte(`{"strength":1,"radius":1,"allowedKinds":["avatar","avatar"]}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateConfigJSON(schema, config); !errors.Is(err, errConfigSchemaMismatch) {
				t.Fatalf("invalid config returned %v, want schema mismatch", err)
			}
		})
	}

	for name, config := range map[string][]byte{
		"numeric boundaries": []byte(`{"strength":10,"radius":4.999,"allowedKinds":["avatar"]}`),
		"unique collection":  []byte(`{"strength":0,"radius":0.001,"allowedKinds":["avatar","item"]}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateConfigJSON(schema, config); err != nil {
				t.Fatalf("valid config rejected: %v", err)
			}
		})
	}
}

func TestConfigSchemaRejectsInvalidOrUnsupportedSchemas(t *testing.T) {
	for name, schema := range map[string][]byte{
		"unknown keyword":       []byte(`{"type":"number","multipleOf":2}`),
		"unknown nested":        []byte(`{"type":"object","properties":{"x":{"type":"number","default":1}}}`),
		"reversed number range": []byte(`{"type":"number","minimum":2,"maximum":1}`),
		"reversed item range":   []byte(`{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":1}`),
		"negative item bound":   []byte(`{"type":"array","items":{"type":"string"},"minItems":-1}`),
		"invalid pattern":       []byte(`{"type":"string","pattern":"["}`),
		"trailing document":     []byte(`{"type":"number"}{"type":"number"}`),
	} {
		t.Run(name, func(t *testing.T) {
			err := validateConfigJSON(schema, []byte(`0`))
			if err == nil || errors.Is(err, errConfigSchemaMismatch) {
				t.Fatalf("invalid schema returned %v, want an explicit schema error", err)
			}
		})
	}
}
