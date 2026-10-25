package setup

import (
	"regexp"
	"strings"
)

// maxShellDepth bounds how far nested substitutions are followed. Agents
// rarely nest $(…) more than a level or two; deeper text stays part of the
// word it appears in instead of being split again.
const maxShellDepth = 16

// shellSegment is one simple command of a shell line: its source text, which
// the text rule matches (see judgeText) and a reason may quote, and its words
// with quoting removed, which the word rules judge.
type shellSegment struct {
	text  string
	words []string
	// terminator is the control operator that ended the segment: ";", "&&",
	// "||", "|", "|&", "&", or "\n"; "" when the line, a group, or a
	// substitution ended instead.
	terminator string
	// scope is the command list the segment belongs to: 0 for the line
	// itself, and a new one for each ( group ) and each substitution, nested
	// in the scope it appears in. A `cd` changes the directory of its own
	// scope only, which is how a subshell behaves.
	scope int
	// documents are the bodies of the segment's here-documents, which are
	// input rather than commands: a rule reads one only as what the command
	// reads (a shell runs it, cat passes it on).
	documents []hereBody
	// pipedGroup is the scope of the ( … ) group whose output is piped into
	// the segment, as in (echo cmd) | sh; 0 when there is none.
	pipedGroup int
}

// hereBody is one here-document body and the index, among its segment's
// words, of the operator word (<<EOF) that introduced it.
type hereBody struct {
	word int
	body string
}

// document is the body of the here-document whose operator is words[index].
func (segment shellSegment) document(index int) (string, bool) {
	for _, document := range segment.documents {
		if document.word == index {
			return document.body, true
		}
	}
	return "", false
}

// shellLine is a split line: its segments in the order they run (a
// substitution before the command that uses it) and each scope's parent,
// -1 for the line itself.
type shellLine struct {
	segments []shellSegment
	parents  []int
	// source is the line as written. partial says that the splitter could not
	// read all of it as the shell does: a quote, a substitution or a ( group
	// ran off its end, or a substitution was nested deeper than maxShellDepth
	// and stayed part of a word. Past any of them the splitter and the shell
	// may no longer agree about where the commands are.
	source  string
	partial bool
	// glob says that an unquoted *, ? or [ stands in a word of some command,
	// quotes, escapes, comments and here-document bodies aside: the shell may
	// expand it into the names of files, which are arguments (or options) that
	// the line does not spell out.
	glob bool
	// plainBackslashes counts the backslashes of source that stand inside the
	// single-quoted strings the scan read, where a backslash is an ordinary
	// character ('%s\n', 'a\|b'). Any other backslash of source is an escape, or
	// may be one: outside quotes, in double quotes, in a comment, or in the body
	// of a here-document.
	plainBackslashes int
	// before and after hold, for each segment, the nearest segment before
	// and after it in its own scope (-1 when there is none); last holds the
	// last segment of each scope. A rule walks a scope by these links, not by
	// scanning every segment in between.
	before, after, last []int
	// files indexes the files the line's commands write, built on first use
	// (see writtenScript).
	files *lineFiles
	// groupReads counts the commands of groups that the rules have read for
	// the text they print (see maxGroupReads); every copy of the line shares
	// it, and so do the scripts it hands on (see parseScript).
	groupReads *int
}

// splitShell splits a shell line into the simple commands it runs. It breaks
// on unquoted `;`, `&`, `&&`, `||`, `|`, `|&`, `(`, `)` and newlines, drops
// comments and line continuations, and returns the body of every `$(…)`,
// `<(…)`, `>(…)` and backtick substitution as segments of its own, because a
// substitution runs no matter which command it appears in. Single and double
// quotes and backslash escapes are honoured. It is a splitter, not a parser:
// the rules only need to know where each command starts and what it runs.
// The text of each segment is its source as written, quotes included, with a
// placeholder for each substitution body and nothing for a here-document
// body; the text rule reads exactly that.
func splitShell(line string) []shellSegment {
	return parseShellLine(line).segments
}

// parseShellLine is splitShell plus the scope tree, for rules that follow a
// line's `cd`s, pipelines, and `&&` chains.
func parseShellLine(line string) shellLine {
	splitter := shellSplitter{line: line, parents: []int{-1}}
	splitter.scan(0, 0, 0, 0)
	parsed := shellLine{
		segments:         splitter.segments,
		parents:          splitter.parents,
		source:           line,
		partial:          splitter.partial,
		glob:             splitter.glob,
		plainBackslashes: splitter.plainBackslashes,
		files:            &lineFiles{},
		groupReads:       new(int),
	}
	parsed.linkScopes()
	return parsed
}

// parseScript parses a script that a command of the line hands on to be run.
// The script is a line of its own, but it shares the reading of groups of the
// line it came from, so that the call as a whole is bounded, not each script.
func (line shellLine) parseScript(text string) shellLine {
	script := parseShellLine(text)
	script.groupReads = line.groupReads
	return script
}

// linkScopes fills in before, after and last.
func (line *shellLine) linkScopes() {
	line.before = make([]int, len(line.segments))
	line.after = make([]int, len(line.segments))
	line.last = make([]int, len(line.parents))
	following := make([]int, len(line.parents))
	for scope := range line.last {
		line.last[scope], following[scope] = -1, -1
	}
	for index, segment := range line.segments {
		line.before[index], line.last[segment.scope] = line.last[segment.scope], index
	}
	for index := len(line.segments) - 1; index >= 0; index-- {
		scope := line.segments[index].scope
		line.after[index], following[scope] = following[scope], index
	}
}

// commandWords returns the assignments that prefix a segment's command
// (FOO=1, including those an env wrapper sets) and its words from the
// program on, after grouping words and keywords ({, !, then, do) and the
// wrappers that run their arguments (sudo, env, command, exec, time, nohup)
// with their options.
func (segment shellSegment) commandWords() (assignments []string, words []string) {
	words = segment.words
	for len(words) > 0 {
		word := words[0]
		switch {
		case isShellAssignment(word):
			assignments = append(assignments, word)
			words = words[1:]
			continue
		case shellKeywords[word]:
			words = words[1:]
			continue
		case shellWrappers[word]:
			words = words[1:]
			for len(words) > 0 && strings.HasPrefix(words[0], "-") {
				words = words[1:]
			}
			continue
		}
		return assignments, words
	}
	return assignments, nil
}

// program is the basename of the command a segment runs (see commandWords).
// It is "" when nothing is left.
func (segment shellSegment) program() string {
	_, words := segment.commandWords()
	if len(words) == 0 {
		return ""
	}
	return baseName(words[0])
}

func baseName(word string) string {
	return word[strings.LastIndexByte(word, '/')+1:]
}

var (
	shellKeywords = map[string]bool{
		"{": true, "}": true, "!": true, "if": true, "then": true, "else": true,
		"elif": true, "fi": true, "do": true, "done": true, "while": true, "until": true,
	}
	shellWrappers = map[string]bool{
		"sudo": true, "env": true, "command": true, "exec": true, "time": true, "nohup": true,
	}
)

func isShellAssignment(word string) bool {
	name, _, found := strings.Cut(word, "=")
	if !found || name == "" {
		return false
	}
	for index, r := range name {
		letter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if !letter && (index == 0 || r < '0' || r > '9') {
			return false
		}
	}
	return true
}

type shellSplitter struct {
	line     string
	segments []shellSegment
	parents  []int
	// partial is set when a quote, a substitution or a ( group runs off the end
	// of the line, and when a substitution is too deep to split (see
	// shellLine).
	partial bool
	// glob is set when an unquoted *, ? or [ stands in a word (see shellLine).
	glob bool
	// plainBackslashes counts the backslashes in single quotes (see shellLine).
	plainBackslashes int
}

// newScope opens a command list nested in parent.
func (splitter *shellSplitter) newScope(parent int) int {
	splitter.parents = append(splitter.parents, parent)
	return len(splitter.parents) - 1
}

// segmentBuilder accumulates the segment being read.
type segmentBuilder struct {
	text   strings.Builder
	word   strings.Builder
	inWord bool
	words  []string
}

func (builder *segmentBuilder) literal(value string) {
	builder.word.WriteString(value)
	builder.text.WriteString(value)
	builder.inWord = true
}

func (builder *segmentBuilder) endWord() {
	if builder.inWord {
		builder.words = append(builder.words, builder.word.String())
		builder.word.Reset()
		builder.inWord = false
	}
}

// endWordBeforeInput ends the word being read where an input operator (<<<
// or <<) starts, so `bash<<<'cmd'` is bash reading a here-string rather than
// one word. A file descriptor number stays with its operator (0<<<'cmd').
func (builder *segmentBuilder) endWordBeforeInput() {
	if word := builder.word.String(); word == "" || strings.Trim(word, "0123456789") != "" {
		builder.endWord()
	}
}

func (builder *segmentBuilder) flush(splitter *shellSplitter, scope int, terminator string) {
	builder.endWord()
	if len(builder.words) > 0 {
		splitter.segments = append(splitter.segments, shellSegment{
			text:       builder.text.String(),
			words:      builder.words,
			terminator: terminator,
			scope:      scope,
		})
	}
	builder.text.Reset()
	builder.words = nil
}

// scan splits line[start:] until it reaches closer outside quotes and
// parentheses (closer 0 scans to the end of the line), and returns the index
// just past what it consumed. Its segments belong to scope, or to the groups
// opened inside it.
func (splitter *shellSplitter) scan(start int, closer byte, depth int, scope int) int {
	line := splitter.line
	var current segmentBuilder
	// groups holds the scopes of the ( … ) groups open here, innermost last.
	groups := []int{scope}
	inner := func() int { return groups[len(groups)-1] }
	// documents are the here-documents whose bodies start after this line;
	// claimed is how many of them a flushed segment already reads.
	var documents []hereDocument
	claimed := 0
	// closedGroup is the scope of the ( … ) group that closed just before
	// the current character, with nothing but blanks since; pipedGroup is the
	// one piped into the next segment.
	closedGroup, pipedGroup := 0, 0
	flush := func(terminator string) {
		before := len(splitter.segments)
		current.flush(splitter, inner(), terminator)
		if len(splitter.segments) == before {
			return
		}
		// The segment just flushed is the command that reads the bodies of the
		// here-documents read since the last one, and the group piped into it.
		// Those are the documents after the claimed ones, so a line of
		// thousands of operators does not walk them all at every flush.
		for ; claimed < len(documents); claimed++ {
			documents[claimed].segment = before
		}
		splitter.segments[before].pipedGroup, pipedGroup = pipedGroup, 0
	}
	next := func(index int) byte {
		if index+1 < len(line) {
			return line[index+1]
		}
		return 0
	}
	// operatorAt is where the last `<` or `>` stood as an operator: not quoted,
	// not escaped. A `|` or `&` right after it belongs to it (>|, >&, <&); after
	// a quoted or escaped one it is a pipe or a background operator, whatever
	// the character before it is.
	operatorAt := -1
	afterOperator := func(index int) byte {
		if operatorAt >= 0 && operatorAt == index-1 {
			return line[operatorAt]
		}
		return 0
	}
	index := start
	for index < len(line) {
		character := line[index]
		if character != ' ' && character != '\t' && character != ')' && character != '|' {
			closedGroup = 0
		}
		switch {
		case closer != 0 && character == closer && (closer != ')' || len(groups) == 1):
			flush("")
			return index + 1
		case character == '<' && strings.HasPrefix(line[index:], "<<<"):
			// A here-string is one word of input.
			current.endWordBeforeInput()
			current.literal("<<<")
			index += 3
		case character == '<' && next(index) == '<':
			if end, document, ok := readHereDocument(line, index); ok {
				current.endWordBeforeInput()
				document.word = len(current.words)
				// A line continuation inside the operator and its delimiter is
				// not part of the word the shell reads.
				current.literal(strings.ReplaceAll(line[index:end], "\\\n", ""))
				documents = append(documents, document)
				index = end
			} else {
				current.literal("<<")
				index += 2
			}
		case character == '\\':
			switch {
			case index+1 >= len(line):
				current.literal(`\`)
				index++
			case line[index+1] == '\n':
				// A line continuation joins the two lines.
				index += 2
			default:
				current.word.WriteByte(line[index+1])
				current.text.WriteString(line[index : index+2])
				current.inWord = true
				index += 2
			}
		case character == '\'':
			stop := len(line)
			body := line[index+1:]
			if end := strings.IndexByte(body, '\''); end >= 0 {
				body = body[:end]
				stop = index + 1 + end + 1
				splitter.plainBackslashes += strings.Count(body, "\\")
			} else {
				splitter.partial = true
			}
			current.word.WriteString(body)
			current.text.WriteString(line[index:stop])
			current.inWord = true
			index = stop
		case character == '"':
			index = splitter.doubleQuoted(&current, index, depth, inner())
		case character == '`':
			index = splitter.substitution(&current, index, index+1, '`', depth, inner())
		case (character == '$' || character == '<' || character == '>') && next(index) == '(':
			index = splitter.substitution(&current, index, index+2, ')', depth, inner())
		case character == '#' && !current.inWord:
			// A comment runs to the end of the line.
			for index < len(line) && line[index] != '\n' {
				index++
			}
		case character == ' ' || character == '\t':
			current.endWord()
			current.text.WriteByte(character)
			index++
		case character == '(':
			flush("")
			groups = append(groups, splitter.newScope(inner()))
			index++
		case character == ')':
			flush("")
			closedGroup = 0
			if len(groups) > 1 {
				closedGroup = inner()
				groups = groups[:len(groups)-1]
			}
			index++
		case character == '\n' || character == ';':
			flush(string(character))
			index++
			if character == '\n' && len(documents) > 0 {
				// Here-document bodies are the command's input, not commands,
				// except for the substitutions the shell expands in them.
				index = splitter.readHereDocuments(index, documents, inner(), depth)
				documents, claimed = nil, 0
			}
		case character == '|' && afterOperator(index) == '>':
			// `>|` redirects despite noclobber; it is not a pipe.
			current.literal("|")
			index++
		case character == '|':
			terminator := "|"
			if next(index) == '|' || next(index) == '&' {
				terminator = line[index : index+2]
			}
			if terminator != "||" && closedGroup > 0 && !current.inWord && len(current.words) == 0 {
				// (echo cmd) | sh: the group's output is the next command's input.
				pipedGroup = closedGroup
			}
			closedGroup = 0
			flush(terminator)
			index += len(terminator)
		case character == '&':
			switch {
			case next(index) == '&':
				flush("&&")
				index += 2
			case next(index) == '>' || afterOperator(index) != 0:
				// A redirection (&>, 2>&1, <&3), not a background job.
				current.literal("&")
				index++
			default:
				flush("&")
				index++
			}
		default:
			// What reaches here is unquoted and unescaped.
			switch character {
			case '<', '>':
				operatorAt = index
			case '*', '?', '[':
				splitter.glob = true
			}
			current.literal(line[index : index+1])
			index++
		}
	}
	flush("")
	if closer != 0 || len(groups) > 1 {
		// The body of a substitution, or a ( group, ran off the end of the
		// line. A shell calls that a syntax error, or in zsh a pattern.
		splitter.partial = true
	}
	return index
}

// doubleQuoted reads a double-quoted string starting at line[start] into the
// current word. Substitutions inside it still run, so they are split out too.
func (splitter *shellSplitter) doubleQuoted(current *segmentBuilder, start int, depth int, scope int) int {
	line := splitter.line
	current.inWord = true
	current.text.WriteByte('"')
	index := start + 1
	for index < len(line) {
		character := line[index]
		switch {
		case character == '"':
			current.text.WriteByte(character)
			return index + 1
		case character == '\\' && index+1 < len(line) && strings.IndexByte("$`\"\\\n", line[index+1]) >= 0:
			if line[index+1] != '\n' {
				current.word.WriteByte(line[index+1])
				current.text.WriteString(line[index : index+2])
			}
			index += 2
		case character == '`':
			index = splitter.substitution(current, index, index+1, '`', depth, scope)
		case character == '$' && index+1 < len(line) && line[index+1] == '(':
			index = splitter.substitution(current, index, index+2, ')', depth, scope)
		default:
			current.word.WriteByte(character)
			current.text.WriteByte(character)
			index++
		}
	}
	splitter.partial = true
	return index
}

// substitution splits the body of a command, process, or backtick
// substitution into segments of its own scope, nested in scope, and keeps
// its source as part of the word it appears in. The segment's text, which the
// text rule reads, holds only a placeholder: the body's commands are judged
// as segments of their own, and its here-documents not at all. Past
// maxShellDepth the body is only skipped over, to its matching closer, and
// stays plain text, which makes the line partial.
func (splitter *shellSplitter) substitution(current *segmentBuilder, open int, body int, closer byte, depth int, scope int) int {
	line := splitter.line
	end := body
	if depth < maxShellDepth {
		end = splitter.scan(body, closer, depth+1, splitter.newScope(scope))
		current.word.WriteString(line[open:end])
		current.text.WriteString(line[open:body] + "…" + string(closer))
		current.inWord = true
		return end
	}
	splitter.partial = true
	for nesting := 0; end < len(line); {
		character := line[end]
		end++
		if character == closer && (closer != ')' || nesting == 0) {
			break
		}
		if character == '(' {
			nesting++
		} else if character == ')' {
			nesting--
		}
	}
	current.literal(line[open:end])
	return end
}

// hereDocument is a here-document (<<word or <<-word) whose body starts on
// the line after its operator.
type hereDocument struct {
	delimiter string
	// stripTabs is <<-, whose delimiter line may be indented with tabs.
	stripTabs bool
	// quoted is a delimiter with any quoting in it ('EOF', "EOF", \EOF),
	// which leaves the body as literal text; the shell expands the body of
	// any other.
	quoted bool
	// segment is the index of the segment whose command reads the body, -1
	// until that segment is complete; word is its operator word's index.
	segment int
	word    int
}

// readHereDocument reads the operator and delimiter word at line[index:]
// (quoted or not) and returns the index just past them. Only a name-like
// delimiter counts, so arithmetic such as $(( 1 << 2 )) is left alone, and so
// is a word whose escaped blank or metacharacter (<<E\ F) is part of the
// delimiter the shell reads.
func readHereDocument(line string, index int) (int, hereDocument, bool) {
	document := hereDocument{segment: -1}
	position := index + 2
	if position < len(line) && line[position] == '-' {
		document.stripTabs = true
		position++
	}
	for position < len(line) && (line[position] == ' ' || line[position] == '\t') {
		position++
	}
	var delimiter strings.Builder
	for position < len(line) && !strings.ContainsRune(" \t\n;|&<>()", rune(line[position])) {
		switch character := line[position]; character {
		case '\'', '"':
			end := strings.IndexByte(line[position+1:], character)
			if end < 0 {
				return 0, hereDocument{}, false
			}
			delimiter.WriteString(line[position+1 : position+1+end])
			position += end + 2
			document.quoted = true
		case '\\':
			if position+1 < len(line) && line[position+1] == '\n' {
				// A line continuation joins what follows, from the next line,
				// to the delimiter: `<<EOF\` and `hi` is the delimiter EOFhi.
				position += 2
				continue
			}
			// Any other backslash quotes the character after it, a blank, a
			// metacharacter or another backslash included, and the delimiter is
			// the word without the backslash: <<E\ F is "E F", which is no name,
			// so the << is left alone. A backslash that ends the line is itself.
			if position+1 < len(line) {
				position++
			}
			delimiter.WriteByte(line[position])
			position++
			document.quoted = true
		default:
			delimiter.WriteByte(character)
			position++
		}
	}
	if !hereDocumentDelimiter.MatchString(delimiter.String()) {
		return 0, hereDocument{}, false
	}
	document.delimiter = delimiter.String()
	return position, document, true
}

var hereDocumentDelimiter = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// readHereDocuments reads the bodies of documents, which follow one another
// from line[start:], onto the segments whose commands read them, and returns
// the index just past them. A body without its delimiter line runs to the
// end of the input. The shell runs the substitutions in the body of a
// document whose delimiter is unquoted, so those become segments of their
// own, in scopes nested in the scope of the command that reads the body.
func (splitter *shellSplitter) readHereDocuments(start int, documents []hereDocument, scope int, depth int) int {
	line := splitter.line
	index := start
	for _, document := range documents {
		var body strings.Builder
		for index < len(line) {
			var text string
			text, index = hereDocumentLine(line, index, !document.quoted)
			if document.stripTabs {
				text = strings.TrimLeft(text, "\t")
			}
			if text == document.delimiter {
				break
			}
			body.WriteString(text)
			body.WriteByte('\n')
		}
		reader := scope
		if document.segment >= 0 {
			segment := &splitter.segments[document.segment]
			segment.documents = append(segment.documents, hereBody{word: document.word, body: body.String()})
			reader = segment.scope
		}
		if !document.quoted {
			splitter.expandHereDocument(body.String(), reader, depth)
		}
	}
	return index
}

// hereDocumentLine reads the line of a here-document body that starts at
// line[start:], and returns its text and the index of the line after it. In
// the body of a document whose delimiter is unquoted, which the shell expands,
// a backslash and a newline join two lines into one, so a line that ends in
// one is not a delimiter line, and the line that follows it may be (EOF\ and
// an empty line is EOF). A backslash also quotes the character after it, a
// backslash included. In any other body every line stands as written.
func hereDocumentLine(line string, start int, expanded bool) (string, int) {
	if !expanded {
		if end := strings.IndexByte(line[start:], '\n'); end >= 0 {
			return line[start : start+end], start + end + 1
		}
		return line[start:], len(line)
	}
	var text strings.Builder
	for index := start; index < len(line); {
		switch character := line[index]; {
		case character == '\\' && index+1 < len(line) && line[index+1] == '\n':
			index += 2
		case character == '\\' && index+1 < len(line):
			text.WriteString(line[index : index+2])
			index += 2
		case character == '\n':
			return text.String(), index + 1
		default:
			text.WriteByte(character)
			index++
		}
	}
	return text.String(), len(line)
}

// expandHereDocument splits out the command and backtick substitutions in
// the body of a here-document the shell expands. A backslash quotes the
// character after it ($, `, \ and a newline), and a quote means nothing.
func (splitter *shellSplitter) expandHereDocument(body string, scope int, depth int) {
	inner := shellSplitter{line: body, segments: splitter.segments, parents: splitter.parents}
	var unused segmentBuilder
	for index := 0; index < len(body); {
		switch {
		case body[index] == '\\':
			index += 2
		case body[index] == '`':
			index = inner.substitution(&unused, index, index+1, '`', depth, scope)
		case body[index] == '$' && index+1 < len(body) && body[index+1] == '(':
			index = inner.substitution(&unused, index, index+2, ')', depth, scope)
		default:
			index++
		}
	}
	splitter.segments, splitter.parents = inner.segments, inner.parents
	splitter.partial = splitter.partial || inner.partial
	splitter.glob = splitter.glob || inner.glob
}
