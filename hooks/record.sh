#!/bin/sh
# Claude Code hooks handler: writes the event from stdin as a separate file into the spool of the
# torch data directory (plan §7.2). Package S1.
# `torch setup` installs the script into <data directory>/hooks, so the spool is the sibling
# directory of the script itself: there are no torch variables in the hook environment.
# The file is written under a temporary dot-prefixed name and moved with `mv`: the receiver sees
# the event only whole. The event time is the file modification time. The handler never disturbs
# the session: on any error it writes nothing to stdout or stderr, and the exit code is always 0.
{
  case "$0" in
    */*) spool="${0%/*}/../spool" ;;
    *) spool="../spool" ;;
  esac
  name="$(date +%s)-$$"
  tmp="$spool/.$name.tmp"
  umask 077
  mkdir -p "$spool" &&
    cat > "$tmp" &&
    [ -s "$tmp" ] &&
    mv "$tmp" "$spool/$name.json" ||
    rm -f "$tmp"
} >/dev/null 2>&1
exit 0
