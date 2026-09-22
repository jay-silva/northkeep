#!/bin/bash
# ADR 0053 canary: runs the exact Decision 2 environment, -c pins, plumbing
# export sequence and read-only verify sequence against a hostile repository
# built in a fresh mktemp directory under $TMPDIR. Every program the repository
# names is a canary that records its own name. Prints "(none)" when no canary
# fired, the fired names otherwise, the disk, HEAD and independently computed
# blob ids for every exported file, whether verify changed any file, replace
# refs, the push stage against a local bare repository standing in for the
# remote (URL form, legacy remote files, push guard), and the temp-file writer.
# Exits nonzero on any fire, a blob mismatch, a verify that wrote anything, or
# a positive control that did not fire (the hostile setup would not be live).
# Touches nothing outside its temp directory. Needs no network.
set -u
exec </dev/null
GIT=/usr/bin/git
LAB=$(mktemp -d "${TMPDIR:-/tmp}/adr0053-canary.XXXXXX") || exit 2
LAB=$(cd "$LAB" && pwd -P)
trap 'rm -rf "$LAB"' EXIT
N=$LAB/nkhome; UH=$LAB/userhome; CAN=$LAB/can; F=$LAB/fired; FC=$LAB/fired-control
mkdir -p "$N/hooks" "$N/export" "$UH/.config/git" "$CAN" "$LAB/hk"
: > "$N/empty.gitconfig"; : > "$F"; : > "$FC"
FAIL=0

# One canary program per name. It never reads stdin, so no filter protocol
# can deadlock on it; it records its name and exits 0.
can() { local p="$CAN/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  printf '#!/bin/sh\necho "%s" >> "%s"\nexit 0\n' "$1" "$F" > "$p"; chmod +x "$p"; echo "$p"; }

# Decision 2, verbatim: the environment and the -c pins.
PINS=(-c "core.hooksPath=$N/hooks" -c core.fsmonitor=false -c core.useBuiltinFSMonitor=false
  -c gpg.program=/usr/bin/false -c commit.gpgsign=false -c tag.gpgsign=false
  -c core.sshCommand=/usr/bin/false -c credential.helper= -c diff.external=
  -c core.editor=/usr/bin/false -c sequence.editor=/usr/bin/false -c core.pager=cat
  -c core.askPass=/usr/bin/false -c core.gitProxy= -c core.alternateRefsCommand=
  -c core.autocrlf=false -c core.safecrlf=false -c core.symlinks=false
  -c protocol.ext.allow=never -c uploadpack.packObjectsHook= -c user.useConfigOnly=true)
ENVB=(PATH=/usr/bin:/bin "HOME=$N" GIT_CONFIG_NOSYSTEM=1 "GIT_CONFIG_GLOBAL=$N/empty.gitconfig"
  GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
  GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false)
ENVP=("${ENVB[@]}" GIT_NO_REPLACE_OBJECTS=1)   # ENVB alone is used only by the controls
wd() { /usr/bin/perl -e 'alarm 20; exec @ARGV or exit 127' "$@"; }   # watchdog, no coreutils timeout on macOS
sha() { printf '%s' "$1" | /usr/bin/shasum -a 256 | cut -c1-64; }
# G: the product runner, temporary index. GD: the same, default index (the reconcile).
G()  { local r=$1; shift; wd env -i "${ENVP[@]}" "GIT_INDEX_FILE=$N/export/$(sha "$r").index" "$GIT" -C "$r" "${PINS[@]}" "$@"; }
GD() { local r=$1; shift; wd env -i "${ENVP[@]}" "$GIT" -C "$r" "${PINS[@]}" "$@"; }
# S: setup only, before the repository is armed, with the same isolation.
S()  { local r=$1; shift; wd env -i "${ENVP[@]}" "$GIT" -C "$r" "${PINS[@]}" "$@"; }

HOOKS="applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg
 commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive
 post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite
 sendemail-validate fsmonitor-watchman post-index-change"
KEYS="core.fsmonitor core.sshCommand core.editor core.pager core.askPass core.gitProxy
 core.alternateRefsCommand gpg.program gpg.ssh.program gpg.x509.program diff.external sequence.editor
 ssh.variant uploadpack.packObjectsHook credential.helper merge.nk.driver trailer.nk.command"

# Arm a repository: every config key, both hook locations, attribute source 3 (and 4 when
# asked), filter drivers a1..a5, the process filter, and a gpg.program reached through include.path.
arm() { local r=$1 gd h k a; gd=$(S "$r" rev-parse --path-format=absolute --git-dir)
  for h in $HOOKS; do cp "$(can "hook:.git/hooks/$h")" "$gd/hooks/$h"; cp "$(can "hook:core.hooksPath/$h")" "$LAB/hk/$h"; done
  for k in $KEYS; do S "$r" config "$k" "$(can "$k")"; done
  for a in a1 a2 a3 a4 a5; do
    S "$r" config "filter.$a.clean" "$(can "filter.$a.clean")"; S "$r" config "filter.$a.smudge" "$(can "filter.$a.smudge")"
    S "$r" config "diff.$a.textconv" "$(can "diff.$a.textconv")"; S "$r" config "merge.$a.driver" "$(can "merge.$a.driver")"; done
  S "$r" config filter.nkp.process "$(can filter.nkp.process)"; S "$r" config filter.nkp.required true
  printf '[gpg]\n\tprogram = %s\n' "$(can gpg.program-via-include.path)" > "$gd/extra.config"
  S "$r" config include.path "$gd/extra.config"
  S "$r" config core.hooksPath "$LAB/hk"; S "$r" config core.autocrlf true; S "$r" config commit.gpgsign true
  printf 'projects/s3.md %s\n' "$(ATTR a3)" > "$gd/info/attributes"                        # source 3
  [ "${2:-}" = attrfile ] || return 0
  printf 'projects/s4.md %s\n' "$(ATTR a4)" > "$LAB/attributes"                             # source 4
  S "$r" config core.attributesFile "$LAB/attributes"; }
ATTR() { echo "filter=$1 diff=$1 merge=$1 working-tree-encoding=UTF-16 text eol=crlf"; }

# Hostile main repository. Source 1 is committed before any driver exists, so setup runs nothing.
R=$LAB/repo; R0=$LAB/root; W=$LAB/wt; mkdir -p "$R/projects" "$R0/projects"
S "$R" init -q; S "$R" config user.name O; S "$R" config user.email o@e.invalid
printf 'projects/s1.md %s\nINDEX.md filter=nkp\n' "$(ATTR a1)" > "$R/.gitattributes"          # source 1, in HEAD
S "$R" add .gitattributes; S "$R" commit -q -m base
S "$R" worktree add -q --no-checkout "$W" -b wtb                                            # linked worktree
S "$R0" init -q; S "$R0" config user.name O; S "$R0" config user.email o@e.invalid           # unborn HEAD
arm "$R" attrfile; arm "$R0"
S "$R" config extensions.worktreeConfig true; S "$W" config --worktree core.fsmonitor "$(can core.fsmonitor-config.worktree)"
mkdir -p "$W/projects"
printf 's2.md %s\n' "$(ATTR a2)" > "$R/projects/.gitattributes"                            # source 2, untracked
printf 'projects/root.md %s\n' "$(ATTR a5)" > "$UH/.config/git/attributes"                 # source 5, a user's global file
body() { printf '<!-- northkeep: vault v project %s revision r kind document\n     The vault is canonical. -->\n# %s\n\nplaintext body\n' "$1" "$1"; }
for s in s1 s2 s3 s4; do body $s > "$R/projects/$s.md"; done
body index > "$R/INDEX.md"; body wt > "$W/projects/s3.md"; body root > "$R0/projects/root.md"
marker() { printf '<!-- northkeep: vault v kind marker\n     This folder is a NorthKeep mirror. -->\n' > "$1/.northkeep-mirror"; }
marker "$R"; marker "$R0"
: > "$F"

# The Decision 2 and 3 sequence, one repository, one export.
export_run() { local r=$1; shift; local gd cd top p b hb c t par
  G "$r" var GIT_COMMITTER_IDENT >/dev/null || { echo "no identity: refused"; FAIL=1; return; }
  top=$(G "$r" rev-parse --show-toplevel); [ "$top" = "$r" ] || { echo "toplevel mismatch: $top"; FAIL=1; }
  [ "$(G "$r" rev-parse --is-bare-repository)" = false ] || FAIL=1
  gd=$(G "$r" rev-parse --path-format=absolute --git-dir); cd=$(G "$r" rev-parse --path-format=absolute --git-common-dir)
  echo "  git-dir=${gd#$LAB/} common-dir=${cd#$LAB/}"
  [ -e "$gd/index.lock" ] && { echo "  refused: $gd/index.lock exists"; FAIL=1; return; }
  G "$r" remote -v >/dev/null; G "$r" worktree list --porcelain >/dev/null
  if par=$(G "$r" rev-parse --verify -q HEAD); then G "$r" read-tree HEAD; G "$r" ls-tree HEAD -- projects >/dev/null
  else par=; G "$r" read-tree --empty; echo "  unborn HEAD: root-commit path"; fi
  for p in "$@"; do
    [ -n "$par" ] && hb=$(G "$r" rev-parse -q --verify "HEAD:$p" 2>/dev/null)
    G "$r" hash-object --no-filters -- "$r/$p" >/dev/null                                   # classifyTarget diskBlob
    b=$(G "$r" hash-object -w --no-filters --stdin < "$r/$p")          # rendered bytes, journaled before the write
    [ "$(G "$r" hash-object --no-filters -- "$r/$p")" = "$b" ] || { echo "  post-write mismatch: $p"; FAIL=1; }
    G "$r" update-index --add --cacheinfo "100644,$b,$p"; done
  t=$(G "$r" write-tree)
  if [ -n "$par" ]; then c=$(printf 'export: test\n' | G "$r" commit-tree "$t" -p "$par")
  else c=$(printf 'export: test\n' | G "$r" commit-tree "$t"); fi
  [ -e "$gd/index.lock" ] && { echo "  refused before update-ref: lock"; FAIL=1; return; }
  if [ -n "$par" ]; then G "$r" update-ref -m "northkeep export" HEAD "$c" "$par"; else G "$r" update-ref -m "northkeep export" HEAD "$c"; fi
  for p in "$@"; do GD "$r" update-index --add --cacheinfo "100644,$(G "$r" rev-parse "HEAD:$p"),$p"; done   # reconcile
  for p in "$@"; do local d h i sz
    d=$(G "$r" hash-object --no-filters -- "$r/$p"); h=$(G "$r" rev-parse "HEAD:$p")
    sz=$(wc -c < "$r/$p" | tr -d ' '); i=$( { printf 'blob %s\0' "$sz"; cat "$r/$p"; } | /usr/bin/shasum -a 1 | cut -c1-40)
    G "$r" ls-tree HEAD -- "$p" >/dev/null
    [ "$d" = "$h" ] && [ "$h" = "$i" ] && m=equal || { m=MISMATCH; FAIL=1; }
    echo "  $p disk=${d:0:12} head=${h:0:12} sha1=${i:0:12} $m"; done; }

# The Decision 8 verify sequence: read-only, filter-free. The file bytes stand in for the render.
snap() { { find "$1" -type f -print0 | sort -z | xargs -0 /usr/bin/shasum; ls -la "$1"; } 2>/dev/null | /usr/bin/shasum | cut -c1-40; }
verify_run() { local r=$1; shift; local gd cd before after p rb hb db n=0 ok=0
  gd=$(G "$r" rev-parse --path-format=absolute --git-dir); cd=$(G "$r" rev-parse --path-format=absolute --git-common-dir)
  before="$(snap "$gd")$(snap "$cd")$(snap "$r")$(snap "$N")"
  G "$r" ls-tree HEAD -- projects/ >/dev/null
  for p in "$@"; do n=$((n+1))
    rb=$(G "$r" hash-object --no-filters --stdin < "$r/$p"); hb=$(G "$r" rev-parse -q --verify "HEAD:$p")
    db=$(G "$r" hash-object --no-filters -- "$r/$p"); [ "$rb" = "$hb" ] && [ "$hb" = "$db" ] && ok=$((ok+1)); done
  after="$(snap "$gd")$(snap "$cd")$(snap "$r")$(snap "$N")"
  [ "$before" = "$after" ] && u=unchanged || { u=CHANGED; FAIL=1; }
  [ "$ok" = "$n" ] || FAIL=1
  echo "  verify: $ok/$n match, repository and NORTHKEEP_HOME $u"; }

echo "git: $("$GIT" --version)"
echo "hostile: $(echo $HOOKS | wc -w | tr -d ' ') hooks in each of .git/hooks and core.hooksPath, $(echo $KEYS | wc -w | tr -d ' ') program keys, 21 driver keys, 5 attribute sources"
echo "main repository:"
M="projects/s1.md projects/s2.md projects/s3.md projects/s4.md INDEX.md .northkeep-mirror"
export_run "$R" $M; verify_run "$R" $M
BL=$(G "$R" rev-parse HEAD:projects/s1.md); T=$(G "$R" rev-parse 'HEAD^{tree}')
FB=$(printf 'FOREIGN\n' | S "$R" hash-object -w --stdin)
SI() { local r=$1; shift; wd env -i "${ENVP[@]}" "GIT_INDEX_FILE=$LAB/ft.index" "$GIT" -C "$r" "${PINS[@]}" "$@"; }
SI "$R" read-tree HEAD; SI "$R" update-index --cacheinfo "100644,$FB,projects/s1.md"; FT=$(SI "$R" write-tree)
S "$R" replace -f "$BL" "$FB" 2>/dev/null; S "$R" replace -f "$T" "$FT" 2>/dev/null
echo "  replace refs planted on the current blob and tree:"; verify_run "$R" $M
G "$R" read-tree HEAD; [ "$(G "$R" write-tree)" = "$T" ] && echo "  read-tree HEAD under the pinned env: the real tree, not the replacement" || { echo "  REPLACED TREE READ"; FAIL=1; }
echo "linked worktree:"; export_run "$W" projects/s3.md; verify_run "$W" projects/s3.md
echo "fresh repository:"; export_run "$R0" projects/root.md .northkeep-mirror; verify_run "$R0" projects/root.md .northkeep-mirror
# The push step: its own environment and pins, by confirmed URL, one fixed ref. A local
# bare repository stands in for GitHub; the lab adds protocol.file.allow, nothing else.
PUSHPINS=(-c "core.hooksPath=$N/hooks" -c core.fsmonitor=false -c protocol.allow=never
  -c protocol.https.allow=always -c protocol.ssh.allow=always -c push.gpgSign=false
  -c gpg.program=/usr/bin/false -c push.recurseSubmodules=no -c submodule.recurse=false
  -c push.followTags=false -c core.askPass=/usr/bin/false -c core.alternateRefsCommand=
  -c http.sslVerify=true)
PENV=(PATH=/usr/bin:/bin "HOME=$UH" GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false
  SSH_ASKPASS=/usr/bin/false GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1)
LABPIN=(-c protocol.file.allow=always)
P() { local r=$1; shift; wd env -i "${PENV[@]}" "$GIT" -C "$r" "${PUSHPINS[@]}" "$@"; }
URL=$LAB/remote.git; EVIL=$LAB/evil.git; S "$LAB" init -q --bare "$URL"; S "$LAB" init -q --bare "$EVIL"
valid_url() { case "$1" in https://?*|ssh://?*) echo ok;; *@*:*) echo "refused, use ssh://${1%%:*}/${1#*:}";; *) echo refused;; esac; }
ALLOW='^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|user\.(name|email)|extensions\.objectformat)='
# config --list -z: records alternate scope and key\nvalue; command-scope pins are skipped.
offending() { G "$1" config --list --show-scope --includes -z |
  /usr/bin/perl -0ne 'chomp; if (!defined $s) { $s = $_; next } my ($k, $v) = split /\n/, $_, 2;
    print "$k=$v\n" unless $s eq "command"; undef $s' |
  grep -Ev "$ALLOW" | grep -Fvx "remote.origin.url=$URL" | grep -Fvx 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*'; }
# nk_commit: one export commit by plumbing; its id is journaled as NorthKeep's.
nk_commit() { local r=$1 p=$2 par t b c; if par=$(G "$r" rev-parse --verify -q HEAD); then G "$r" read-tree HEAD; else par=; G "$r" read-tree --empty; fi
  b=$(G "$r" hash-object -w --no-filters --stdin < "$r/$p"); G "$r" update-index --add --cacheinfo "100644,$b,$p"; t=$(G "$r" write-tree)
  if [ -n "$par" ]; then c=$(printf 'export\n' | G "$r" commit-tree "$t" -p "$par"); G "$r" update-ref HEAD "$c" "$par"
  else c=$(printf 'export\n' | G "$r" commit-tree "$t"); G "$r" update-ref HEAD "$c"; fi
  echo "$c" >> "$LAB/nk-$(basename "$r")"; echo "$c"; }
# push_guard: HEAD on the recorded branch, every commit since the last push NorthKeep's own.
push_guard() { local r=$1 br=$2 last=$3 id range
  [ "$(G "$r" rev-parse --symbolic-full-name HEAD)" = "refs/heads/$br" ] || { echo "HEAD is not on $br"; return 1; }
  if [ -n "$last" ]; then range="$last..HEAD"; else range=HEAD; fi
  for id in $(G "$r" rev-list "$range"); do grep -qx "$id" "$LAB/nk-$(basename "$r")" || { echo "commit ${id:0:12} was not made by NorthKeep"; return 1; }; done; }
mk() { mkdir -p "$1"; S "$1" init -q; S "$1" config user.name O; S "$1" config user.email o@e.invalid; body "$(basename "$1")" > "$1/INDEX.md"; }
push_one() { P "$1" "${LABPIN[@]}" push --porcelain --no-verify "$2" "$3:refs/heads/main" >/dev/null 2>&1; }
echo "push:"
for u in https://github.com/o/m.git ssh://git@github.com/o/m.git git@github.com:o/m.git; do echo "  url $u: $(valid_url "$u")"; done
R1=$LAB/clean; mk "$R1"; C1=$(nk_commit "$R1" INDEX.md); BR=$(G "$R1" rev-parse --abbrev-ref HEAD); S "$R1" remote add origin "$URL"
gd1=$(G "$R1" rev-parse --path-format=absolute --git-dir)
for u in https://mirror.invalid/o/m.git ssh://git@mirror.invalid/o/m.git "$URL"; do for d in remotes branches; do
  mkdir -p "$(dirname "$gd1/$d/$u")"; done
  printf 'URL: %s\nPush: refs/heads/*:refs/heads/*\n' "$EVIL" > "$gd1/remotes/$u"; printf '%s\n' "$EVIL" > "$gd1/branches/$u"; done
for u in https://mirror.invalid/o/m.git ssh://git@mirror.invalid/o/m.git; do
  [ "$(P "$R1" ls-remote --get-url "$u")" = "$u" ] && echo "  planted .git/remotes and .git/branches files at ${u%%:*} URL: resolves to itself" || { echo "  $u REDIRECTED"; FAIL=1; }; done
n=$(offending "$R1" | wc -l | tr -d ' '); [ "$n" = 0 ] || { echo "  clean mirror preflight: $n keys"; FAIL=1; }
g=$(push_guard "$R1" "$BR" "") && push_one "$R1" "$URL" "$C1" || { echo "  clean push refused: $g"; FAIL=1; }
[ "$(P "$R1" "${LABPIN[@]}" ls-remote "$URL" refs/heads/main | cut -c1-40)" = "$C1" ] && [ -z "$(P "$R1" "${LABPIN[@]}" ls-remote "$EVIL")" ] &&
  echo "  clean mirror: guard and allowlist pass, <commit>:main pushed, ls-remote = commit, evil.git empty" || { echo "  clean mirror push FAILED"; FAIL=1; }
P "$R1" push --porcelain --no-verify "$URL" "$C1:refs/heads/fileproto" >/dev/null 2>&1 && { echo "  product pins allowed a file URL"; FAIL=1; } ||
  echo "  product pins, local path URL: refused (https and ssh only)"
echo 'tax notes' > "$R1/scratch.txt"; S "$R1" add scratch.txt; S "$R1" commit -q -m mine; body clean2 > "$R1/INDEX.md"; C2=$(nk_commit "$R1" INDEX.md)
g=$(push_guard "$R1" "$BR" "$C1") && { push_one "$R1" "$URL" "$C2"; echo "  scratch.txt commit PUSHED"; FAIL=1; } || echo "  user commit under NorthKeep's: refused (${g/commit ????????????/commit <user>})"
R2=$LAB/side; mk "$R2"; D1=$(nk_commit "$R2" INDEX.md); BR2=$(G "$R2" rev-parse --abbrev-ref HEAD)
S "$R2" branch side; S "$R2" symbolic-ref HEAD refs/heads/side; body side > "$R2/INDEX.md"; D2=$(nk_commit "$R2" INDEX.md)
g=$(push_guard "$R2" "$BR2" "$D1") && { echo "  side-branch commit PUSHED"; FAIL=1; } || echo "  HEAD on a side branch: refused ($g)"
[ "$(P "$R1" "${LABPIN[@]}" ls-remote "$URL" refs/heads/main | cut -c1-40)" = "$C1" ] || { echo "  remote moved"; FAIL=1; }
for k in remote.origin.receivepack remote.origin.uploadpack; do S "$R" config "$k" "$(can "$k")"; done
S "$R" config remote.origin.url "$URL"; S "$R" config remote.origin.pushurl "$EVIL"
S "$R" config "url.$EVIL.insteadOf" "$URL"; S "$R" config "url.$EVIL.pushInsteadOf" "$URL"
S "$R" config push.gpgSign true; S "$R" config protocol.allow always; S "$R" config http.sslVerify false
n=$(offending "$R" | wc -l | tr -d ' '); [ "$n" -gt 0 ] && echo "  hostile mirror: refused before push, $n local keys outside the allowlist" || FAIL=1
P "$R" "${LABPIN[@]}" push --porcelain --no-verify "$URL" "HEAD:refs/heads/belt" >/dev/null 2>&1
[ -n "$(P "$R" "${LABPIN[@]}" ls-remote "$EVIL" 2>/dev/null)" ] && ev=yes || ev=no
echo "  pins alone on the hostile mirror: url.insteadOf redirected the push: $ev (why the allowlist exists)"

# The mirror file writer: containment covers the temp path, then O_CREAT|O_EXCL|O_NOFOLLOW.
mw() { local t=$1 tmp="$1.northkeep-tmp"
  if [ -e "$tmp" ] || [ -L "$tmp" ]; then echo "containment refused: ${tmp#$LAB/} exists"; fi
  /usr/bin/perl -MFcntl -e 'sysopen(my $f, $ARGV[0], O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0644) or do { print "open refused: $!\n"; exit 1 };
    print $f $ARGV[2]; close $f; rename($ARGV[0], $ARGV[1]) or exit 1' "$tmp" "$t" "$2"; }
echo "temp file:"
printf 'OUTSIDE ORIGINAL\n' > "$LAB/outside.txt"; ln -s "$LAB/outside.txt" "$R0/projects/root.md.northkeep-tmp"
ln -s "$LAB/absent.txt" "$R0/projects/INDEX.northkeep-tmp" 2>/dev/null
r1=$(mw "$R0/projects/root.md" 'PLAINTEXT' | tr '\n' ';'); r2=$(mw "$R0/projects/INDEX" 'PLAINTEXT' | tr '\n' ';')
[ "$(cat "$LAB/outside.txt")" = 'OUTSIDE ORIGINAL' ] && [ ! -e "$LAB/absent.txt" ] && [ ! -L "$R0/projects/root.md" ] &&
  case "$r1$r2" in *"containment refused"*"open refused: File exists"*"open refused: File exists"*)
    echo "  symlink at the temp path, existing and dangling: containment refused, O_EXCL|O_NOFOLLOW open refused (File exists), nothing outside changed";;
    *) echo "  temp refusal missing: $r1 $r2"; FAIL=1;; esac || { echo "  TEMP WRITE ESCAPED"; FAIL=1; }

echo "canaries fired:"; if [ -s "$F" ]; then sort -u "$F" | sed 's/^/  /'; FAIL=1; else echo "  (none)"; fi

# Positive controls, proving the hostile setup is live. They are not product calls.
cp "$F" "$FC.main"; : > "$F"
for s in s1 s2 s3 s4; do wd env -i "${ENVP[@]}" "$GIT" -C "$R" hash-object -- "projects/$s.md" >/dev/null 2>&1; done
wd env -i "${ENVP[@]}" "HOME=$UH" "$GIT" -C "$R0" hash-object -- projects/root.md >/dev/null 2>&1
wd env -i "${ENVP[@]}" "$GIT" -C "$R" update-ref refs/canary/control HEAD >/dev/null 2>&1
wd env -i "${PENV[@]}" "$GIT" -C "$R" "${LABPIN[@]}" push origin HEAD:refs/heads/ctl >/dev/null 2>&1
wd env -i "${PENV[@]}" "$GIT" -C "$R" "${LABPIN[@]}" push "$URL" HEAD:refs/heads/ctl2 >/dev/null 2>&1
[ "$(wd env -i "${ENVB[@]}" "$GIT" -C "$R" cat-file -p HEAD:projects/s1.md)" = FOREIGN ] && echo replace-ref.live >> "$F"
mkdir -p "$gd1/remotes"; printf 'URL: %s\n' "$EVIL" > "$gd1/remotes/git@mirror.invalid:m.git"
[ "$(P "$R1" ls-remote --get-url git@mirror.invalid:m.git 2>/dev/null)" = "$EVIL" ] && echo legacy-remote.scp-redirect >> "$F"
printf 'FOLLOWED\n' > "$R0/projects/root.md.northkeep-tmp"; [ "$(cat "$LAB/outside.txt")" = FOLLOWED ] && echo tempfile.symlink.followed >> "$F"
echo "controls (must fire):"; sort -u "$F" | tr '\n' ' ' | sed 's/^/  /'; echo
for want in filter.a1.clean filter.a2.clean filter.a3.clean filter.a4.clean filter.a5.clean hook:core.hooksPath/reference-transaction \
    hook:core.hooksPath/pre-push remote.origin.receivepack replace-ref.live legacy-remote.scp-redirect tempfile.symlink.followed; do
  grep -qx "$want" "$F" || { echo "  control did not fire: $want"; FAIL=1; }; done
[ "$FAIL" = 0 ] && echo "result: PASS" || echo "result: FAIL"
exit "$FAIL"
