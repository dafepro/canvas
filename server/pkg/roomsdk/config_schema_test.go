package roomsdk

import "testing"

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
