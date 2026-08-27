package roomsdk

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	Minimum              *float64                `json:"minimum,omitempty"`
	Maximum              *float64                `json:"maximum,omitempty"`
	ExclusiveMinimum     *float64                `json:"exclusiveMinimum,omitempty"`
	ExclusiveMaximum     *float64                `json:"exclusiveMaximum,omitempty"`
	MinItems             *int                    `json:"minItems,omitempty"`
	MaxItems             *int                    `json:"maxItems,omitempty"`
	UniqueItems          bool                    `json:"uniqueItems,omitempty"`
}

func validateConfigJSON(schemaRaw, configRaw json.RawMessage) error {
	if len(schemaRaw) == 0 || len(configRaw) == 0 {
		return errConfigSchemaMismatch
	}
	var schema configSchema
	decoder := json.NewDecoder(bytes.NewReader(schemaRaw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&schema); err != nil {
		return fmt.Errorf("invalid item config schema: %w", err)
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return fmt.Errorf("invalid item config schema: %w", err)
	}
	if err := validateConfigSchema(schema, "$", make(map[string]struct{})); err != nil {
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
		if schema.MinItems != nil && len(array) < *schema.MinItems {
			return errConfigSchemaMismatch
		}
		if schema.MaxItems != nil && len(array) > *schema.MaxItems {
			return errConfigSchemaMismatch
		}
		seen := make(map[string]struct{}, len(array))
		for _, child := range array {
			if err := validateConfigValue(*schema.Items, child); err != nil {
				return err
			}
			if schema.UniqueItems {
				encoded, err := json.Marshal(child)
				if err != nil {
					return errConfigSchemaMismatch
				}
				key := string(encoded)
				if _, duplicate := seen[key]; duplicate {
					return errConfigSchemaMismatch
				}
				seen[key] = struct{}{}
			}
		}
		return nil

	case "number":
		number, ok := value.(float64)
		if !ok {
			return errConfigSchemaMismatch
		}
		if schema.Minimum != nil && number < *schema.Minimum {
			return errConfigSchemaMismatch
		}
		if schema.Maximum != nil && number > *schema.Maximum {
			return errConfigSchemaMismatch
		}
		if schema.ExclusiveMinimum != nil && number <= *schema.ExclusiveMinimum {
			return errConfigSchemaMismatch
		}
		if schema.ExclusiveMaximum != nil && number >= *schema.ExclusiveMaximum {
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

func rejectTrailingJSON(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateConfigSchema(
	schema configSchema,
	path string,
	visitedRequired map[string]struct{},
) error {
	switch schema.Type {
	case "object":
		clear(visitedRequired)
		for _, required := range schema.Required {
			if required == "" {
				return fmt.Errorf("%s.required contains an empty property name", path)
			}
			if _, duplicate := visitedRequired[required]; duplicate {
				return fmt.Errorf("%s.required contains duplicate %q", path, required)
			}
			visitedRequired[required] = struct{}{}
			if _, exists := schema.Properties[required]; !exists {
				return fmt.Errorf("%s.required references unknown property %q", path, required)
			}
		}
		for name, property := range schema.Properties {
			if name == "" {
				return fmt.Errorf("%s.properties contains an empty name", path)
			}
			if err := validateConfigSchema(
				property,
				fmt.Sprintf("%s.properties[%q]", path, name),
				make(map[string]struct{}),
			); err != nil {
				return err
			}
		}
	case "array":
		if schema.Items == nil {
			return fmt.Errorf("%s.items is required for an array", path)
		}
		if schema.MinItems != nil && *schema.MinItems < 0 {
			return fmt.Errorf("%s.minItems must be non-negative", path)
		}
		if schema.MaxItems != nil && *schema.MaxItems < 0 {
			return fmt.Errorf("%s.maxItems must be non-negative", path)
		}
		if schema.MinItems != nil && schema.MaxItems != nil &&
			*schema.MinItems > *schema.MaxItems {
			return fmt.Errorf("%s.minItems must not exceed maxItems", path)
		}
		if err := validateConfigSchema(
			*schema.Items,
			path+".items",
			make(map[string]struct{}),
		); err != nil {
			return err
		}
	case "number":
		if schema.Minimum != nil && schema.Maximum != nil && *schema.Minimum > *schema.Maximum {
			return fmt.Errorf("%s.minimum must not exceed maximum", path)
		}
		if schema.ExclusiveMinimum != nil && schema.Maximum != nil &&
			*schema.ExclusiveMinimum >= *schema.Maximum {
			return fmt.Errorf("%s.exclusiveMinimum must be less than maximum", path)
		}
		if schema.Minimum != nil && schema.ExclusiveMaximum != nil &&
			*schema.Minimum >= *schema.ExclusiveMaximum {
			return fmt.Errorf("%s.minimum must be less than exclusiveMaximum", path)
		}
		if schema.ExclusiveMinimum != nil && schema.ExclusiveMaximum != nil &&
			*schema.ExclusiveMinimum >= *schema.ExclusiveMaximum {
			return fmt.Errorf("%s.exclusiveMinimum must be less than exclusiveMaximum", path)
		}
	case "string":
		if schema.MinLength != nil && *schema.MinLength < 0 {
			return fmt.Errorf("%s.minLength must be non-negative", path)
		}
		if schema.MaxLength != nil && *schema.MaxLength < 0 {
			return fmt.Errorf("%s.maxLength must be non-negative", path)
		}
		if schema.MinLength != nil && schema.MaxLength != nil &&
			*schema.MinLength > *schema.MaxLength {
			return fmt.Errorf("%s.minLength must not exceed maxLength", path)
		}
		if schema.Pattern != "" {
			if _, err := regexp.Compile(schema.Pattern); err != nil {
				return fmt.Errorf("%s.pattern: %w", path, err)
			}
		}
	case "boolean", "null":
		// These primitive schemas have no additional authored constraints.
	default:
		return fmt.Errorf("%s.type %q is unsupported", path, schema.Type)
	}
	return nil
}
