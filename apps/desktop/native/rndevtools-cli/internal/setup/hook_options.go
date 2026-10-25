package setup

import "strings"

// The options the excuse accepts (see textOnly). git, gh, sort and rg are
// text programs until an option makes one run another program or write a
// file, and the shell hands them options in more spellings than a rule can
// list as dangerous: sort and most git commands (fetch, push, commit, grep)
// accept any unique prefix of a long option (--upl is --upload-pack), a brace
// expansion or a quoted redirection operator can hide the word that follows,
// and an option that takes a value swallows the -- after it (rg -e -- --pre=sh,
// git push -o -- --receive-pack=…), so the words after a -- may be options too.
// So the excuse reads an option only when it can name it: a long option
// spelled in full and listed here, and a short option whose every letter is
// listed. Every word that starts with a dash is read, wherever it stands.
// Anything the excuse cannot name ends it, and the line keeps the text rule's
// verdict.

// optionPolicy is the options of one program that the excuse accepts.
type optionPolicy struct {
	// short are the letters and digits that may make up a cluster of short
	// options (-am, -n5, -k2,2). A letter that takes a value takes the rest
	// of its word, so the characters after it are in the set as well.
	short string
	// long are the long options by exact name, with their dashes.
	long map[string]bool
}

// allows reports whether option, a word that starts with a dash (and is not
// -- or -), is one of the policy's: --name, --name=value, or a cluster.
func (policy optionPolicy) allows(option string) bool {
	if strings.HasPrefix(option, "--") {
		name, _, _ := strings.Cut(option, "=")
		return policy.long[name]
	}
	for _, letter := range option[1:] {
		if !strings.ContainsRune(policy.short, letter) {
			return false
		}
	}
	return true
}

// allowsAll reports whether every word that starts with a dash among
// arguments is an allowed option. That includes the words after a --: an
// option that takes a value swallows the -- (rg -e -- --pre=sh), and the words
// after it are options again. dashesHandOn says that the program passes the
// words after a -- to another one (gh repo clone … -- <git flags>), in which
// case the -- ends the excuse.
func (policy optionPolicy) allowsAll(arguments []string, dashesHandOn bool) bool {
	for _, argument := range arguments {
		switch {
		case argument == "--":
			if dashesHandOn {
				return false
			}
		case argument == "-" || !strings.HasPrefix(argument, "-"):
		case !policy.allows(argument):
			return false
		}
	}
	return true
}

func fields(text string) map[string]bool {
	return names(strings.Fields(text)...)
}

// union is the set of all names in sets.
func union(sets ...map[string]bool) map[string]bool {
	all := map[string]bool{}
	for _, set := range sets {
		for name := range set {
			all[name] = true
		}
	}
	return all
}

const (
	letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	digits  = "0123456789"
)

var (
	// gitOptions: no short option of the listed subcommands runs a program
	// except -c (a config setting such as core.pager, core.sshCommand or
	// core.hooksPath, before or after the subcommand) and -O (git grep opens
	// the matches in a pager), so those two letters are left out. The long
	// options are the ones that select, filter, format or name things; the
	// ones that name a program (--upload-pack, --receive-pack, --exec,
	// --exec-path, --config-env, --open-files-in-pager, --ext-diff,
	// --textconv) or a file to write (--output) are not here.
	gitOptions = optionPolicy{
		short: strings.NewReplacer("c", "", "O", "").Replace(letters) + digits,
		long: union(
			// Before the subcommand.
			fields(`--no-pager --no-optional-locks --literal-pathspecs --glob-pathspecs --noglob-pathspecs
				--icase-pathspecs --no-replace-objects --bare --git-dir --work-tree --namespace`),
			// add, rm, mv.
			fields(`--all --update --verbose --quiet --dry-run --force --intent-to-add --ignore-errors --ignore-missing
				--no-all --sparse --refresh --renormalize --ignore-unmatch`),
			// commit.
			fields(`--amend --author --date --allow-empty --allow-empty-message --edit --no-edit --no-verify
				--no-post-rewrite --signoff --no-signoff --message --file --short --long --porcelain --branch --null
				--only --include --fixup --squash --reuse-message --reset-author --cleanup --status --no-status
				--trailer --template --untracked-files --pathspec-from-file --pathspec-file-nul --no-gpg-sign`),
			// log, show, diff, status.
			fields(`--oneline --graph --decorate --no-decorate --stat --shortstat --numstat --name-only --name-status
				--summary --patch --no-patch --cached --staged --merge-base --no-index --max-count --skip --since
				--until --after --before --committer --grep --all-match --invert-grep --regexp-ignore-case
				--extended-regexp --fixed-strings --basic-regexp --perl-regexp --branches --tags --remotes
				--first-parent --merges --no-merges --reverse --follow --format --pretty --abbrev-commit
				--no-abbrev-commit --abbrev --relative-date --date-order --topo-order --author-date-order --color
				--no-color --color-words --word-diff --word-diff-regex --check --exit-code --diff-filter
				--find-renames --find-copies --no-renames --ignore-space-change --ignore-all-space
				--ignore-blank-lines --ignore-cr-at-eol --ignore-space-at-eol --unified --function-context
				--src-prefix --dst-prefix --no-prefix --full-index --binary --text --minimal --patience --histogram
				--diff-algorithm --raw --compact-summary --dirstat --cumulative --pickaxe-all --pickaxe-regex
				--left-right --cherry-pick --cherry-mark --boundary --simplify-by-decoration --full-history
				--ancestry-path --children --parents --notes --no-notes --show-notes --log-size --source
				--use-mailmap --mailmap --encoding --no-walk --do-walk --glob --exclude --stat-width
				--stat-name-width --stat-count --stat-graph-width --no-ext-diff --no-textconv --show-stash
				--ahead-behind --no-ahead-behind --ignored --ignore-submodules --column --no-column --renames`),
			// branch, tag, stash.
			fields(`--list --delete --annotate --contains --no-contains --merged --no-merged --points-at --sort
				--verify --ignore-case --create-reflog --show-current --move --copy --set-upstream-to
				--unset-upstream --track --no-track --omit-empty --include-untracked --keep-index --no-keep-index
				--index`),
			// push, fetch.
			fields(`--set-upstream --force-with-lease --force-if-includes --follow-tags --prune --atomic --push-option
				--repo --recurse-submodules --no-recurse-submodules --ipv4 --ipv6 --no-force-with-lease
				--no-force-if-includes --thin --no-thin --progress --no-progress --no-tags --depth --deepen
				--unshallow --shallow-since --shallow-exclude --append --multiple --jobs --prune-tags
				--update-head-ok --keep --filter --refmap --write-fetch-head --no-write-fetch-head --auto-gc
				--no-auto-gc --show-forced-updates --no-show-forced-updates --refetch`),
			// checkout, switch, restore.
			fields(`--detach --merge --orphan --ours --theirs --create --force-create --guess --no-guess
				--discard-changes --ignore-skip-worktree-bits --overlay --no-overlay --conflict --worktree
				--ignore-unmerged`),
			// grep.
			fields(`--untracked --no-exclude-standard --exclude-standard --line-number --word-regexp --invert-match
				--count --files-with-matches --files-without-match --full-name --only-matching --show-function
				--context --before-context --after-context --max-depth --heading --break --and --or --not --threads
				--recursive --no-recursive`),
			// blame, describe.
			fields(`--line-porcelain --incremental --show-email --show-name --show-number --root --ignore-rev
				--ignore-revs-file --contents --score-debug --show-stats --color-lines --color-by-age --always
				--dirty --broken --match --candidates --exact-match --debug`),
			// rev-parse, ls-files.
			fields(`--show-toplevel --show-prefix --show-cdup --absolute-git-dir --git-common-dir --abbrev-ref
				--is-inside-work-tree --is-bare-repository --is-inside-git-dir --symbolic --symbolic-full-name
				--git-path --show-superproject-working-tree --is-shallow-repository --default --revs-only --no-revs
				--flags --no-flags --path-format --others --killed --modified --deleted --stage --unmerged
				--directory --no-empty-directory --eol --error-unmatch --deduplicate --with-tree --exclude-from
				--exclude-per-directory --resolve-undo`),
		),
	}

	// ghOptions: gh runs a program only for the git flags after -- (gh repo
	// clone), an editor (--editor) or a browser (--web), so those are not
	// listed, and neither is the short -e or -w that stands for one.
	ghOptions = optionPolicy{
		short: strings.NewReplacer("e", "", "w", "").Replace(letters) + digits,
		long: fields(`
			--repo --json --jq --template --limit --state --label --assignee --author --search --app --base --head
			--title --body --body-file --draft --fill --fill-first --fill-verbose --reviewer --milestone --project
			--no-maintainer-edit --delete-branch --squash --merge --rebase --auto --disable-auto --admin --subject
			--match-head-commit --comment --approve --request-changes --tag --target --notes --notes-file
			--generate-notes --prerelease --latest --verify-tag --discussion-category --method --field --raw-field
			--header --input --include --silent --paginate --slurp --cache --hostname --verbose --description
			--color --name --force --public --private --internal --mention --archived --no-archived --language
			--topic --owner --sort --order --visibility --source --fork --match --created --updated --closed
			--merged --review --review-requested --reviewed-by --involves --mentions --commenter --comments
			--reactions --interactions --no-assignee --no-label --no-milestone --no-project --branch --delete-last
			--edit-last --create-if-none --add-label --remove-label --add-assignee --remove-assignee
			--add-reviewer --remove-reviewer --add-project --remove-project --stat --name-only --patch --preview
			--version --help
		`),
	}

	// rgOptions: ripgrep runs a program for --pre, --hostname-bin, and for
	// -z/--search-zip (which starts a decompressor), so those are not here.
	rgOptions = optionPolicy{
		short: strings.NewReplacer("z", "").Replace(letters) + digits,
		long: fields(`
			--regexp --file --ignore-case --case-sensitive --smart-case --word-regexp --line-regexp --fixed-strings
			--invert-match --multiline --multiline-dotall --crlf --pcre2 --no-pcre2 --engine --count --count-matches
			--files-with-matches --files-without-match --files --only-matching --replace --max-count --max-columns
			--max-columns-preview --max-depth --max-filesize --maxdepth --after-context --before-context --context
			--context-separator --no-context-separator --line-number --no-line-number --column --no-column
			--byte-offset --with-filename --no-filename --heading --no-heading --color --colors --pretty --vimgrep
			--json --stats --quiet --no-messages --no-ignore-messages --glob --iglob --glob-case-insensitive --type
			--type-not --type-list --type-add --type-clear --hidden --no-hidden --no-ignore --no-ignore-vcs
			--no-ignore-parent --no-ignore-dot --no-ignore-global --no-ignore-files --no-ignore-exclude
			--ignore-file --follow --no-follow --one-file-system --sort --sortr --sort-files --threads --trim
			--no-trim --text --binary --null --null-data --passthru --path-separator --unrestricted --no-config
			--line-buffered --block-buffered --mmap --no-mmap --encoding --no-encoding --field-context-separator
			--field-match-separator --include-zero --version --help --debug --trace
		`),
	}

	// sortOptions: sort runs a program for --compress-program and reads or
	// writes files named by --files0-from, --random-source and
	// --temporary-directory, none of which is here. -o and --output write the
	// result to a file, which the excuse allows but counts as a file written
	// (see sortWrites).
	sortOptions = optionPolicy{
		short: "bcCdfghiMmnRrsuVzkotS" + digits + ",.:",
		long: fields(`
			--reverse --numeric-sort --general-numeric-sort --human-numeric-sort --month-sort --version-sort
			--unique --ignore-case --ignore-leading-blanks --dictionary-order --ignore-nonprinting --stable --check
			--merge --zero-terminated --key --field-separator --sort --output
		`),
	}
)

// gitGlobalValues are git's options before its subcommand that take the next
// word as their value, which is not the subcommand.
var gitGlobalValues = names("-C", "--git-dir", "--work-tree", "--namespace")

// gitReadsText reports a git command that is one of gitTextCommands and
// whose every option is one of gitOptions, before and after the subcommand,
// and after a -- as well: an option that takes a value swallows the --
// (git push -o -- --receive-pack=…), so the words after it may be options.
func gitReadsText(arguments []string) bool {
	command := ""
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case argument == "--":
			if command == "" {
				return false
			}
		case argument == "-" || !strings.HasPrefix(argument, "-"):
			if command == "" {
				command = argument
			}
		case !gitOptions.allows(argument):
			return false
		case command == "" && gitGlobalValues[argument]:
			index++
		}
	}
	return gitTextCommands[command]
}

// ghReadsText reports a gh command that is one of ghTextCommands, whose
// every option is one of ghOptions, and that hands nothing on to git after
// --. gh repo counts only for view and list; its other commands clone,
// create, edit, or delete.
func ghReadsText(arguments []string) bool {
	if len(arguments) == 0 || !ghTextCommands[arguments[0]] || !ghOptions.allowsAll(arguments[1:], true) {
		return false
	}
	if arguments[0] != "repo" {
		return true
	}
	for _, argument := range arguments[1:] {
		if !strings.HasPrefix(argument, "-") {
			return argument == "view" || argument == "list"
		}
	}
	return false
}

// sortWrites reports sort given an output file: -o (also in a cluster, or
// with its file attached). A -- does not end the search: an option that takes
// a value swallows it (sort -k -- -o out), and a file named -o only makes the
// excuse stricter.
func sortWrites(arguments []string) bool {
	for _, argument := range arguments {
		if strings.HasPrefix(argument, "-") && !strings.HasPrefix(argument, "--") && strings.ContainsRune(argument, 'o') {
			return true
		}
	}
	return false
}

// uniqWrites reports uniq given an output file, its second operand.
func uniqWrites(arguments []string) bool {
	operands := 0
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case argument == "--":
			return operands+len(arguments)-index-1 > 1
		case argument == "-f" || argument == "-s" || argument == "-w":
			// The next word is the number of fields or characters.
			index++
		case argument != "-" && strings.HasPrefix(argument, "-"):
		default:
			operands++
		}
	}
	return operands > 1
}

// hasOutputOption reports a --output option (or --output=file), which names
// a file to write for sort and for the commands that print a diff.
func hasOutputOption(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--output" || strings.HasPrefix(argument, "--output=") {
			return true
		}
	}
	return false
}
