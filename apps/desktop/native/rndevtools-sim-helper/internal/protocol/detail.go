package protocol

import "strings"

const maximumDetailRunes = 400

// BoundedDetail collapses whitespace and caps diagnostic text so an underlying
// cause can travel inside an APIError message without unbounded growth. Every
// place that previously reduced a distinct failure to one fixed sentence hid
// the only evidence of what actually went wrong.
func BoundedDetail(text string) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	runes := []rune(collapsed)
	if len(runes) <= maximumDetailRunes {
		return collapsed
	}
	return string(runes[:maximumDetailRunes]) + "…"
}
