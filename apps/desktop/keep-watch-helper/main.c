// Keep Watch helper (ADR 0082). Runs the ADR 0080 off-only script as root
// under launchd. It is a signed program only so Login Items can name it
// NorthKeep; it reads no arguments and no inherited environment. SCRIPT
// must match HELPER_SCRIPT in apps/web/src/keep-watch.ts word for word.
#include <unistd.h>

static const char SCRIPT[] =
  "mk=/var/db/ai.northkeep.keepwatch\n"
  "[ -f \"$mk\" ] && [ ! -L \"$mk\" ] || exit 0\n"
  "t5() { /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' 5 \"$@\"; }\n"
  "id=$(/usr/bin/stat -f %i:%m \"$mk\" 2>/dev/null) || id=x\n"
  "off() {\n"
  "  [ -x /usr/bin/perl ] || t5() { \"$@\"; }\n"
  "  t5 /usr/bin/pmset -a disablesleep 0\n"
  "  s=$(t5 /usr/bin/pmset -g | /usr/bin/awk '/^System-wide power settings:/{f=1;next} /^[^ \\t]/{f=0} f&&$1==\"SleepDisabled\"{print $2;exit}')\n"
  "  [ \"$s\" = 0 ] && [ \"$(/usr/bin/stat -f %i:%m \"$mk\" 2>/dev/null)\" = \"$id\" ] && /bin/rm -f \"$mk\"\n"
  "  exit 0\n"
  "}\n"
  "now=$(/bin/date +%s)\n"
  "{ IFS= read -r hb && IFS= read -r ceil; } < \"$mk\" || off\n"
  "case \"$ceil\" in ''|*[!0-9]*) off ;; esac\n"
  "[ \"$now\" -lt \"$ceil\" ] || off\n"
  "case \"$hb\" in /*) ;; *) off ;; esac\n"
  "m=$(t5 /usr/bin/stat -f '%HT|%m' \"$hb\" 2>/dev/null) || off\n"
  "case \"$m\" in \"Regular File|\"*) m=${m#*|} ;; *) off ;; esac\n"
  "case \"$m\" in ''|*[!0-9]*) off ;; esac\n"
  "age=$((now - m))\n"
  "[ \"$age\" -le 90 ] && [ \"$age\" -ge -60 ] || off\n"
  "b=$(t5 /usr/bin/pmset -g batt) || off\n"
  "l=$(printf '%s\\n' \"$b\" | /usr/bin/grep -m1 'InternalBattery')\n"
  "p=$(printf '%s' \"$l\" | /usr/bin/grep -Eo '[0-9]+%' | /usr/bin/head -1 | /usr/bin/tr -d %)\n"
  "case \"$p\" in ''|*[!0-9]*) off ;; esac\n"
  "case \"$l\" in *\"; charging;\"*|*\"; charged;\"*|*\"; finishing charge;\"*) ;; *) [ \"$p\" -gt 25 ] || off ;; esac\n"
  "t=$(t5 /usr/bin/notifyutil -g com.apple.system.thermalpressurelevel) || off\n"
  "t=${t##* }\n"
  "case \"$t\" in ''|*[!0-9]*) off ;; esac\n"
  "[ \"$t\" -lt 2 ] || off\n"
  "exit 0";

int main(void) {
  char *const argv[] = {"sh", "-c", (char *)SCRIPT, 0};
  char *const envp[] = {"PATH=/usr/bin:/bin:/usr/sbin:/sbin", 0};
  execve("/bin/sh", argv, envp);
  return 127;
}
