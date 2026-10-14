package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/getkin/kin-openapi/routers"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
)

const contractDocumentURI = "https://videocutlist.test/api.openapi.yaml"

func schemaJSONValue(node *yaml.Node) (any, error) {
	switch node.Kind {
	case yaml.DocumentNode:
		return schemaJSONValue(node.Content[0])
	case yaml.MappingNode:
		result := make(map[string]any, len(node.Content)/2)
		for i := 0; i < len(node.Content); i += 2 {
			key, err := schemaJSONValue(node.Content[i])
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, fmt.Errorf("non-string YAML mapping key %v", key)
			}
			value, err := schemaJSONValue(node.Content[i+1])
			if err != nil {
				return nil, err
			}
			result[name] = value
		}
		return result, nil
	case yaml.SequenceNode:
		result := make([]any, len(node.Content))
		for i := range node.Content {
			value, err := schemaJSONValue(node.Content[i])
			if err != nil {
				return nil, err
			}
			result[i] = value
		}
		return result, nil
	case yaml.ScalarNode:
		switch node.Tag {
		case "!!null":
			return nil, nil
		case "!!bool":
			return node.Value == "true", nil
		case "!!int", "!!float":
			return json.Number(node.Value), nil
		default:
			return node.Value, nil
		}
	default:
		return nil, fmt.Errorf("unsupported YAML node kind %d", node.Kind)
	}
}

func pointerToken(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func (c *handlerContract) validateJSONBody(_ interface{ Helper() }, route *routers.Route, kind string, status int, body []byte) error {
	if len(bytes.TrimSpace(body)) == 0 {
		return fmt.Errorf("empty JSON body")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("decode JSON body: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("JSON body has trailing value or data: %v", err)
	}
	method := strings.ToLower(route.Method)
	pointer := "/paths/" + pointerToken(route.Path) + "/" + method
	if kind == "request" {
		pointer += "/requestBody/content/application~1json/schema"
	} else {
		responseKey := fmt.Sprint(status)
		responsePointer := pointer + "/responses/" + pointerToken(responseKey) + "/content/application~1json/schema"
		if _, err := url.PathUnescape(responsePointer); err != nil {
			return err
		}
		pointer = responsePointer
	}
	path := filepath.Join("..", "..", "api", "api.openapi.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		return err
	}
	docValue, err := schemaJSONValue(&root)
	if err != nil {
		return err
	}
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	current := docValue
	for i := 0; i < len(parts); {
		object, ok := current.(map[string]any)
		if !ok {
			return fmt.Errorf("schema pointer %s does not identify an object", pointer)
		}
		if ref, ok := object["$ref"].(string); ok {
			if !strings.HasPrefix(ref, "#/") {
				return fmt.Errorf("unsupported non-local schema reference %q", ref)
			}
			refParts := strings.Split(strings.TrimPrefix(ref, "#/"), "/")
			pointer = "/" + strings.Join(refParts, "/") + "/" + strings.Join(parts[i:], "/")
			parts = append(refParts, parts[i:]...)
			current = docValue
			i = 0
			continue
		}
		key, err := url.PathUnescape(parts[i])
		if err != nil {
			return err
		}
		key = strings.ReplaceAll(strings.ReplaceAll(key, "~1", "/"), "~0", "~")
		current, ok = object[key]
		if !ok {
			return fmt.Errorf("schema pointer token %q not found", key)
		}
		i++
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource(contractDocumentURI, docValue); err != nil {
		return err
	}
	schema, err := compiler.Compile(contractDocumentURI + "#" + pointer)
	if err != nil {
		return fmt.Errorf("compile %s schema pointer %s: %w", kind, pointer, err)
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("validate %s schema: %w", kind, err)
	}
	return nil
}
