package protocol

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBoundedDetailCollapsesWhitespaceAndCapsLength(t *testing.T) {
	if got := BoundedDetail("  first \n\t second  "); got != "first second" {
		t.Fatalf("whitespace was not collapsed: %q", got)
	}
	if got := BoundedDetail(" \n "); got != "" {
		t.Fatalf("blank detail was not emptied: %q", got)
	}
	long := BoundedDetail(strings.Repeat("x", maximumDetailRunes+50))
	if utf8.RuneCountInString(long) != maximumDetailRunes+1 || !strings.HasSuffix(long, "…") {
		t.Fatalf("long detail was not capped with an ellipsis: %d runes", utf8.RuneCountInString(long))
	}
}
