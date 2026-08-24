package roomsdk

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode/utf8"
)

var errConfigSchemaMismatch = errors.New("config does not match the item definition schema")

// configSchema is the deliberately small JSON-schema subset exported by the
// TypeScript definition build. Keeping the language data-only lets Go validate
// durable configuration without executing behavior code.
type configSchema struct {
	Type                 string                  `json:"type"`
	Properties           map[string]configSchema `json:"properties,omitempty"`
	Required             []string                `json:"required,omitempty"`
	Items                *configSchema           `json:"items,omitempty"`
	AdditionalProperties bool                    `json:"additionalProperties,omitempty"`
	Enum                 []string                `json:"enum,omitempty"`
	Const                *string                 `json:"const,omitempty"`
	Pattern              string                  `json:"pattern,omitempty"`
	MinLength            *int                    `json:"minLength,omitempty"`
	MaxLength            *int                    `json:"maxLength,omitempty"`
}

func validateConfigJSON(schemaRaw, configRaw json.RawMessage) error {
	if len(schemaRaw) == 0 || len(configRaw) == 0 {
		return errConfigSchemaMismatch
	}
	var schema configSchema
	if err := json.Unmarshal(schemaRaw, &schema); err != nil {
		return fmt.Errorf("invalid item config schema: %w", err)
	}
	var value any
	if err := json.Unmarshal(configRaw, &value); err != nil {
		return errConfigSchemaMismatch
	}
	if err := validateConfigValue(schema, value); err != nil {
		return errConfigSchemaMismatch
	}
	return nil
}

func validateConfigValue(schema configSchema, value any) error {
	switch schema.Type {
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return errConfigSchemaMismatch
		}
		for _, required := range schema.Required {
			if _, ok := object[required]; !ok {
				return errConfigSchemaMismatch
			}
		}
		for key, child := range object {
			property, known := schema.Properties[key]
			if !known {
				if schema.AdditionalProperties {
					continue
				}
				return errConfigSchemaMismatch
			}
			if err := validateConfigValue(property, child); err != nil {
				return err
			}
		}
		return nil

	case "array":
		array, ok := value.([]any)
		if !ok || schema.Items == nil {
			return errConfigSchemaMismatch
		}
		for _, child := range array {
			if err := validateConfigValue(*schema.Items, child); err != nil {
				return err
			}
		}
		return nil

	case "number":
		if _, ok := value.(float64); !ok {
			return errConfigSchemaMismatch
		}
		return nil
	case "string":
		text, ok := value.(string)
		if !ok {
			return errConfigSchemaMismatch
		}
		length := utf8.RuneCountInString(text)
		if schema.MinLength != nil && length < *schema.MinLength {
			return errConfigSchemaMismatch
		}
		if schema.MaxLength != nil && length > *schema.MaxLength {
			return errConfigSchemaMismatch
		}
		if schema.Const != nil && text != *schema.Const {
			return errConfigSchemaMismatch
		}
		if len(schema.Enum) > 0 {
			matched := false
			for _, candidate := range schema.Enum {
				if text == candidate {
					matched = true
					break
				}
			}
			if !matched {
				return errConfigSchemaMismatch
			}
		}
		if schema.Pattern != "" {
			matched, err := regexp.MatchString(schema.Pattern, text)
			if err != nil || !matched {
				return errConfigSchemaMismatch
			}
		}
		return nil
	case "boolean":
		if _, ok := value.(bool); !ok {
			return errConfigSchemaMismatch
		}
		return nil
	case "null":
		if value != nil {
			return errConfigSchemaMismatch
		}
		return nil
	default:
		return errConfigSchemaMismatch
	}
}
