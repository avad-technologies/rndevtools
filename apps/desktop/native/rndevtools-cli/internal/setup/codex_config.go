package setup

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
)

// Parse TOML before making surgical edits. A regexp cannot distinguish table
// headers from examples inside multiline strings, or preserve multiline arrays,
// quoted headers, nested approval rules, and environment tables on an upgrade.
func mergeCodexServer(raw []byte, executable string) ([]byte, error) {
	var document map[string]any
	if err := toml.Unmarshal(raw, &document); err != nil {
		return nil, errors.New("not valid TOML; fix it by hand, then rerun setup")
	}
	servers, ok := document["mcp_servers"].(map[string]any)
	if _, exists := document["mcp_servers"]; exists && !ok {
		return nil, errors.New("mcp_servers is not a table; fix it by hand, then rerun setup")
	}
	server, ok := servers["rndevtools"].(map[string]any)
	if _, exists := servers["rndevtools"]; exists && !ok || server["url"] != nil {
		return nil, errors.New("rndevtools has a custom or invalid transport; keep it or remove that entry before rerunning setup")
	}
	wanted := map[string]string{
		"command":          tomlString(executable),
		"args":             `["mcp"]`,
		"tool_timeout_sec": fmt.Sprint(codexToolTimeoutSeconds),
	}
	if server["command"] == executable {
		delete(wanted, "command")
	}
	if jsonEqual(server["args"], []string{"mcp"}) {
		delete(wanted, "args")
	}
	// A user's longer timeout is intentional. Upgrade only absent/short budgets.
	switch timeout := server["tool_timeout_sec"].(type) {
	case int64:
		if timeout >= codexToolTimeoutSeconds {
			delete(wanted, "tool_timeout_sec")
		}
	case float64:
		if timeout >= codexToolTimeoutSeconds {
			delete(wanted, "tool_timeout_sec")
		}
	}
	if len(wanted) == 0 {
		return raw, nil
	}

	content := raw
	eol := "\n"
	if bytes.Contains(raw, []byte("\r\n")) {
		eol = "\r\n"
	}
	if len(content) > 0 && content[len(content)-1] != '\n' {
		content = append(bytes.Clone(content), []byte(eol)...)
	}
	type edit struct {
		start, end  int
		replacement string
	}
	var edits []edit
	var table []string
	insertAt := -1
	var parser unstable.Parser
	parser.Reset(content)
	for parser.NextExpression() {
		node := parser.Expression()
		switch node.Kind {
		case unstable.Table, unstable.ArrayTable:
			table = tomlNodeKey(node)
			if slices.Equal(table, []string{"mcp_servers", "rndevtools"}) {
				key := node.Child()
				start := int(key.Raw.Offset)
				insertAt = start + bytes.IndexByte(content[start:], '\n') + 1
			}
		case unstable.KeyValue:
			key := append(slices.Clone(table), tomlNodeKey(node)...)
			if len(key) != 3 || key[0] != "mcp_servers" || key[1] != "rndevtools" {
				continue
			}
			value, needsUpdate := wanted[key[2]]
			if !needsUpdate {
				continue
			}
			start, end := int(node.Raw.Offset), int(node.Raw.Offset+node.Raw.Length)
			// Quoted dotted prefixes may contain '='. Locate the assignment
			// after the final parsed key, preserving the complete original key.
			separator := tomlValueSeparator(content, node)
			if separator < start || separator >= end {
				return nil, errors.New("could not locate the Codex setting; leave it unchanged and fix it by hand")
			}
			edits = append(edits, edit{start, end, string(content[start:separator+1]) + " " + value})
			delete(wanted, key[2])
		}
	}
	if parser.Error() != nil {
		return nil, errors.New("could not read the Codex configuration; leave it unchanged and fix it by hand")
	}
	if len(wanted) > 0 {
		var addition strings.Builder
		if insertAt == -1 {
			insertAt = len(content)
			if len(content) > 0 {
				addition.WriteString(eol)
			}
			addition.WriteString("[mcp_servers.rndevtools]" + eol)
		}
		for _, key := range []string{"command", "args", "tool_timeout_sec"} {
			if value, exists := wanted[key]; exists {
				addition.WriteString(key + " = " + value + eol)
			}
		}
		edits = append(edits, edit{insertAt, insertAt, addition.String()})
	}
	slices.SortFunc(edits, func(a, b edit) int {
		if a.start == b.start {
			// Replace the old expression before inserting missing keys at
			// the same offset, so the insertion never shifts a pending edit.
			return b.end - a.end
		}
		return b.start - a.start
	})
	next := bytes.Clone(content)
	for _, change := range edits {
		replaced := make([]byte, 0, len(next)+len(change.replacement))
		replaced = append(replaced, next[:change.start]...)
		replaced = append(replaced, change.replacement...)
		next = append(replaced, next[change.end:]...)
	}
	var check map[string]any
	if err := toml.Unmarshal(next, &check); err != nil {
		return nil, errors.New("rndevtools uses a custom TOML layout; keep it or use a [mcp_servers.rndevtools] table before rerunning setup")
	}
	return next, nil
}

func tomlNodeKey(node *unstable.Node) []string {
	var key []string
	iterator := node.Key()
	for iterator.Next() {
		key = append(key, string(iterator.Node().Data))
	}
	return key
}

func tomlValueSeparator(raw []byte, node *unstable.Node) int {
	keys := node.Key()
	end := int(node.Raw.Offset)
	for keys.Next() {
		key := keys.Node()
		end = int(key.Raw.Offset + key.Raw.Length)
	}
	limit := int(node.Raw.Offset + node.Raw.Length)
	if separator := bytes.IndexByte(raw[end:limit], '='); separator >= 0 {
		return end + separator
	}
	return -1
}
