#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# agent-workflow installer
# Clones elvisbrevi/agent-workflow and symlinks skills, agents,
# and Claude-MiniMax runners into supported destinations.
# ─────────────────────────────────────────────────────────────

REPO_URL="https://github.com/elvisbrevi/agent-workflow.git"
REPO_BRANCH="main"
CACHE_DIR="${HOME}/.cache/agent-workflow"
CATEGORIES=(utility discovery design planning implementation diagnosis review)
AGENT_CATEGORIES=(agent)
LEGACY_AGENT_NAMES=(afk-issuemerger)
# Historical binary name that the canonical agent renamed away from.
# Obsolete symlinks to it are removed safely during install/uninstall so
# the published product surface only exposes `issue-killer`.
LEGACY_BINARY_NAMES=(claude-minimax-issue-runner)
LEGACY_BINARY_FILES=(AGENT.md run.sh)

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Helpers ─────────────────────────────────────────────────
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✖${NC}  $*" >&2; }
die()   { err "$@"; exit 1; }

TTY_RESPONSE=""

prompt_tty() {
  local prompt="$1" failure_message="$2"
  local response

  if ! { : </dev/tty; } 2>/dev/null; then
    die "$failure_message"
  fi

  if ! IFS= read -r -p "$prompt" response </dev/tty; then
    die "Unable to read interactive input from /dev/tty."
  fi

  TTY_RESPONSE="$response"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install agent-workflow skills and agents via symlinks.

Options:
  --claude-global       Install skills, Claude agents, and runners globally
  --claude-local        Install skills, Claude agents, and runners in D
  --global              Install to ~/.agents/skills/ and ~/.agents/agents/
  --local               Install to D/.agents/ (default D: cwd)
  --opencode            Install to D/.opencode/ (default D: cwd)
  --both                Install to both local .agents/ and .opencode/
  --target D            Project directory for local modes
  --uninstall           Remove installed symlinks
  --dry-run             Show what would be done without changes
  --force               Overwrite existing paths without prompting
  --ref REF             Branch or tag to install from (default: main)
  -h, --help            Show this help

Examples:
  $(basename "$0")                                  # Interactive menu (TTY required)
  $(basename "$0") --claude-global                 # Claude-MiniMax, all projects
  $(basename "$0") --claude-local --target ~/proj  # Claude-MiniMax, one project
  $(basename "$0") --global                        # Shared ~/.agents/ install
  $(basename "$0") --local --target ~/proj         # Local .agents/ install
  $(basename "$0") --both                          # Both local shared directories
  $(basename "$0") --uninstall --claude-global     # Remove Claude Code skills
  $(basename "$0") --dry-run --local               # Preview local install
EOF
}

# ── Parse args ──────────────────────────────────────────────
MODE=""
TARGET=""
DRY_RUN=false
FORCE=false
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-global) MODE="claude-global"; shift ;;
    --claude-local)  MODE="claude-local"; shift ;;
    --global)        MODE="global"; shift ;;
    --local)         MODE="local"; shift ;;
    --opencode)      MODE="opencode"; shift ;;
    --both)          MODE="both"; shift ;;
    --target)        TARGET="$2"; shift 2 ;;
    --uninstall)     UNINSTALL=true; shift ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --force)         FORCE=true; shift ;;
    --ref)           REPO_BRANCH="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "Unknown option: $1. Use --help for usage." ;;
  esac
done

# ── Resolve target dir ──────────────────────────────────────
resolve_target() {
  if [[ -z "$TARGET" ]]; then
    TARGET="$(pwd)"
  fi
  # Resolve to absolute path
  TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" || die "Target directory not found: $TARGET"
}

# ── Clone / update repo ────────────────────────────────────
sync_repo() {
  local ref_label="${REPO_BRANCH}"
  if [[ -d "${CACHE_DIR}/.git" ]]; then
    info "Updating cached repo (${ref_label})..."
    git -C "$CACHE_DIR" fetch --all --tags --quiet 2>/dev/null || true
    git -C "$CACHE_DIR" checkout "$REPO_BRANCH" --quiet 2>/dev/null || true
    git -C "$CACHE_DIR" pull --ff-only --quiet 2>/dev/null || true
  else
    info "Cloning repo to ${CACHE_DIR} (${ref_label})..."
    mkdir -p "$(dirname "$CACHE_DIR")"
    git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$CACHE_DIR" --quiet
  fi
}

# ── Discover skills ─────────────────────────────────────────
# Returns: "category/skill_name" lines
discover_skills() {
  local cache="$1"
  for cat in "${CATEGORIES[@]}"; do
    local cat_dir="${cache}/${cat}"
    [[ -d "$cat_dir" ]] || continue
    for skill_dir in "${cat_dir}"/*/; do
      [[ -f "${skill_dir}SKILL.md" ]] || continue
      local skill_name
      skill_name="$(basename "$skill_dir")"
      echo "${cat}/${skill_name}"
    done
  done
}

# ── Install one skill ───────────────────────────────────────
install_skill() {
  local cache="$1" dest_base="$2" cat="$3" skill="$4"
  local src="${cache}/${cat}/${skill}"
  local dst="${dest_base}/${skill}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  symlink ${CYAN}${dst}${NC} → ${src}"
    return 0
  fi

  if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
    if [[ "$FORCE" == true ]]; then
      rm -rf "$dst"
    else
      warn "Already exists: ${dst}"
      prompt_tty "  Overwrite? [y/N] " "Cannot prompt to overwrite ${dst} without a TTY. Re-run with --force."
      if [[ ! "$TTY_RESPONSE" =~ ^[Yy]$ ]]; then
        warn "Skipped: ${skill}"
        return 0
      fi
      rm -rf "$dst"
    fi
  fi

  ln -s "$src" "$dst"
  ok "Installed: ${skill}"
}

# ── Uninstall one skill ─────────────────────────────────────
uninstall_skill() {
  local dest_base="$1" skill="$2"
  local dst="${dest_base}/${skill}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  remove ${CYAN}${dst}${NC}"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    rm "$dst"
    ok "Removed: ${skill}"
  elif [[ -e "$dst" ]]; then
    warn "Not a symlink, skipped: ${dst}"
  fi
}

# ── Install to a destination ────────────────────────────────
install_to() {
  local cache="$1" dest_base="$2" label="$3"

  echo ""
  echo -e "${BOLD}Installing skills → ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$dest_base"
  fi

  local count=0
  while IFS= read -r entry; do
    local cat="${entry%%/*}"
    local skill="${entry#*/}"
    install_skill "$cache" "$dest_base" "$cat" "$skill"
    count=$((count + 1))
  done < <(discover_skills "$cache")

  echo -e "  ${GREEN}${count} skills processed.${NC}"
}

# ── Uninstall from a destination ────────────────────────────
uninstall_from() {
  local cache="$1" dest_base="$2" label="$3"

  echo ""
  echo -e "${BOLD}Uninstalling skills from ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ ! -d "$dest_base" ]]; then
    warn "Directory does not exist: ${dest_base}"
    return 0
  fi

  local count=0
  while IFS= read -r entry; do
    local skill="${entry#*/}"
    uninstall_skill "$dest_base" "$skill"
    count=$((count + 1))
  done < <(discover_skills "$cache")

  echo -e "  ${GREEN}${count} skills processed.${NC}"
}

# ── Discover agents ─────────────────────────────────────────
# Returns: "agent_name" lines (one per AGENT.md)
discover_agents() {
  local cache="$1"
  for cat in "${AGENT_CATEGORIES[@]}"; do
    local cat_dir="${cache}/${cat}"
    [[ -d "$cat_dir" ]] || continue
    for agent_dir in "${cat_dir}"/*/; do
      [[ -f "${agent_dir}AGENT.md" ]] || continue
      local agent_name
      agent_name="$(basename "$agent_dir")"
      echo "${agent_name}"
    done
  done
}

# ── Install one agent ───────────────────────────────────────
install_agent() {
  local cache="$1" dest_base="$2" agent="$3"
  local src="${cache}/agent/${agent}"
  local dst="${dest_base}/${agent}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  symlink ${CYAN}${dst}${NC} → ${src}"
    return 0
  fi

  if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
    if [[ "$FORCE" == true ]]; then
      rm -rf "$dst"
    else
      warn "Already exists: ${dst}"
      prompt_tty "  Overwrite? [y/N] " "Cannot prompt to overwrite ${dst} without a TTY. Re-run with --force."
      if [[ ! "$TTY_RESPONSE" =~ ^[Yy]$ ]]; then
        warn "Skipped: ${agent}"
        return 0
      fi
      rm -rf "$dst"
    fi
  fi

  ln -s "$src" "$dst"
  ok "Installed agent: ${agent}"
}

# ── Uninstall one agent ─────────────────────────────────────
uninstall_agent() {
  local dest_base="$1" agent="$2"
  local dst="${dest_base}/${agent}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  remove ${CYAN}${dst}${NC}"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    rm "$dst"
    ok "Removed agent: ${agent}"
  elif [[ -e "$dst" ]]; then
    warn "Not a symlink, skipped: ${dst}"
  fi
}

remove_legacy_agent_links() {
  local cache="$1" dest_base="$2"
  local legacy candidate target

  for legacy in "${LEGACY_AGENT_NAMES[@]}"; do
    for candidate in "${dest_base}/${legacy}" "${dest_base}/${legacy}.md"; do
      [[ -L "$candidate" ]] || continue
      target="$(readlink "$candidate")"
      case "$target" in
        "${cache}/agent/${legacy}"|"${cache}/agent/${legacy}/AGENT.md"|"${cache}/agent/${legacy}/run.sh")
          if [[ "$DRY_RUN" == true ]]; then
            echo -e "  ${YELLOW}dry-run${NC}  remove legacy ${CYAN}${candidate}${NC}"
          else
            rm "$candidate"
            ok "Removed legacy agent link: ${legacy}"
          fi
          ;;
      esac
    done
  done
}

# Removes obsolete symlinks that point at the historical
# `claude-minimax-issue-runner` binary. The canonical product surface is
# `issue-killer`; keeping the legacy name on PATH would let an old shell
# script or third-party installer silently invoke the obsolete version.
remove_legacy_binary_links() {
  local cache="$1" dest_base="$2"
  local legacy candidate suffix target file

  for legacy in "${LEGACY_BINARY_NAMES[@]}"; do
    for suffix in "" ".md"; do
      candidate="${dest_base}/${legacy}${suffix}"
      [[ -L "$candidate" ]] || continue
      target="$(readlink "$candidate")"
      matched=false
      for file in "${LEGACY_BINARY_FILES[@]}"; do
        case "$target" in
          "${cache}/agent/${legacy}/${file}"|"${cache}/agent/${legacy}")
            matched=true
            ;;
        esac
      done
      if [[ "$matched" == "true" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
          echo -e "  ${YELLOW}dry-run${NC}  remove legacy ${CYAN}${candidate}${NC}"
        else
          rm "$candidate"
          ok "Removed legacy binary link: ${candidate}"
        fi
      fi
    done
  done
}

# ── Install agents to a destination ─────────────────────────
install_agents_to() {
  local cache="$1" dest_base="$2" label="$3"

  echo ""
  echo -e "${BOLD}Installing agents → ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$dest_base"
  fi

  remove_legacy_agent_links "$cache" "$dest_base"

  local count=0
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    install_agent "$cache" "$dest_base" "$agent"
    count=$((count + 1))
  done < <(discover_agents "$cache")

  echo -e "  ${GREEN}${count} agents processed.${NC}"
}

# ── Uninstall agents from a destination ─────────────────────
uninstall_agents_from() {
  local cache="$1" dest_base="$2" label="$3"

  echo ""
  echo -e "${BOLD}Uninstalling agents from ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ ! -d "$dest_base" ]]; then
    warn "Directory does not exist: ${dest_base}"
    return 0
  fi

  remove_legacy_agent_links "$cache" "$dest_base"

  local count=0
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    uninstall_agent "$dest_base" "$agent"
    count=$((count + 1))
  done < <(discover_agents "$cache")

  echo -e "  ${GREEN}${count} agents processed.${NC}"
}

# ── Claude Code agent definitions ───────────────────────────
install_claude_agent() {
  local cache="$1" dest_base="$2" agent="$3"
  local src="${cache}/agent/${agent}/AGENT.md"
  local dst="${dest_base}/${agent}.md"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  symlink ${CYAN}${dst}${NC} → ${src}"
    return 0
  fi

  if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
    if [[ "$FORCE" == true ]]; then
      rm -rf "$dst"
    else
      warn "Already exists: ${dst}"
      prompt_tty "  Overwrite? [y/N] " "Cannot prompt to overwrite ${dst} without a TTY. Re-run with --force."
      if [[ ! "$TTY_RESPONSE" =~ ^[Yy]$ ]]; then
        warn "Skipped Claude agent: ${agent}"
        return 0
      fi
      rm -rf "$dst"
    fi
  fi

  ln -s "$src" "$dst"
  ok "Installed Claude agent: ${agent}"
}

uninstall_claude_agent() {
  local dest_base="$1" agent="$2"
  local dst="${dest_base}/${agent}.md"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  remove ${CYAN}${dst}${NC}"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    rm "$dst"
    ok "Removed Claude agent: ${agent}"
  elif [[ -e "$dst" ]]; then
    warn "Not a symlink, skipped: ${dst}"
  fi
}

process_claude_agents() {
  local action="$1" cache="$2" dest_base="$3" label="$4"
  local count=0 agent heading="Installing"

  [[ "$action" == "uninstalling" ]] && heading="Uninstalling"

  echo ""
  echo -e "${BOLD}${heading} Claude agents → ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ "$action" == "installing" && "$DRY_RUN" == false ]]; then
    mkdir -p "$dest_base"
  elif [[ "$action" == "uninstalling" && ! -d "$dest_base" ]]; then
    warn "Directory does not exist: ${dest_base}"
    return 0
  fi

  remove_legacy_agent_links "$cache" "$dest_base"
  remove_legacy_binary_links "$cache" "$dest_base"

  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    if [[ "$action" == "installing" ]]; then
      install_claude_agent "$cache" "$dest_base" "$agent"
    else
      uninstall_claude_agent "$dest_base" "$agent"
    fi
    count=$((count + 1))
  done < <(discover_agents "$cache")

  echo -e "  ${GREEN}${count} Claude agents processed.${NC}"
}

# ── Claude-MiniMax runner launchers ─────────────────────────
install_runner() {
  local cache="$1" dest_base="$2" agent="$3"
  local src="${cache}/agent/${agent}/run.sh"
  local dst="${dest_base}/${agent}"

  [[ -f "$src" ]] || return 0

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  symlink ${CYAN}${dst}${NC} → ${src}"
    return 0
  fi

  if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
    if [[ "$FORCE" == true ]]; then
      rm -rf "$dst"
    else
      warn "Already exists: ${dst}"
      prompt_tty "  Overwrite? [y/N] " "Cannot prompt to overwrite ${dst} without a TTY. Re-run with --force."
      if [[ ! "$TTY_RESPONSE" =~ ^[Yy]$ ]]; then
        warn "Skipped runner: ${agent}"
        return 0
      fi
      rm -rf "$dst"
    fi
  fi

  ln -s "$src" "$dst"
  ok "Installed runner: ${agent}"
}

uninstall_runner() {
  local dest_base="$1" agent="$2"
  local dst="${dest_base}/${agent}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}dry-run${NC}  remove ${CYAN}${dst}${NC}"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    rm "$dst"
    ok "Removed runner: ${agent}"
  elif [[ -e "$dst" ]]; then
    warn "Not a symlink, skipped: ${dst}"
  fi
}

process_runners() {
  local action="$1" cache="$2" dest_base="$3" label="$4"
  local count=0 agent heading="Installing"

  [[ "$action" == "uninstalling" ]] && heading="Uninstalling"

  echo ""
  echo -e "${BOLD}${heading} runners → ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  if [[ "$action" == "installing" && "$DRY_RUN" == false ]]; then
    mkdir -p "$dest_base"
  elif [[ "$action" == "uninstalling" && ! -d "$dest_base" ]]; then
    warn "Directory does not exist: ${dest_base}"
    return 0
  fi

  remove_legacy_agent_links "$cache" "$dest_base"
  remove_legacy_binary_links "$cache" "$dest_base"

  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    [[ -f "${cache}/agent/${agent}/run.sh" ]] || continue
    if [[ "$action" == "installing" ]]; then
      install_runner "$cache" "$dest_base" "$agent"
    else
      uninstall_runner "$dest_base" "$agent"
    fi
    count=$((count + 1))
  done < <(discover_agents "$cache")

  echo -e "  ${GREEN}${count} runners processed.${NC}"
}

# ── List discovered skills ──────────────────────────────────
list_skills() {
  local cache="$1"
  echo -e "\n${BOLD}Skills found:${NC}"
  while IFS= read -r entry; do
    local cat="${entry%%/*}"
    local skill="${entry#*/}"
    echo -e "  ${CYAN}${cat}${NC}/${skill}"
  done < <(discover_skills "$cache")
}

# ── List discovered agents ──────────────────────────────────
list_agents() {
  local cache="$1"
  echo -e "\n${BOLD}Agents found:${NC}"
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    echo -e "  ${CYAN}agent${NC}/${agent}"
  done < <(discover_agents "$cache")
}

# ── Interactive menu ────────────────────────────────────────
interactive_menu() {
  echo ""
  echo -e "${BOLD}agent-workflow skill installer${NC}"
  echo ""
  echo "¿Dónde instalar las skills y agents?"
  echo ""
  echo -e "  ${CYAN}1)${NC} Claude Code global  → ~/.claude/ + ~/.local/bin/"
  echo -e "  ${CYAN}2)${NC} Claude Code local   → {proyecto}/.claude/"
  echo -e "  ${CYAN}3)${NC} Shared global       → ~/.agents/skills/ + ~/.agents/agents/"
  echo -e "  ${CYAN}4)${NC} Local .agents/      → {proyecto}/.agents/skills/ + {proyecto}/.agents/agents/"
  echo -e "  ${CYAN}5)${NC} Local .opencode/    → {proyecto}/.opencode/skills/ + {proyecto}/.opencode/agent/"
  echo -e "  ${CYAN}6)${NC} Ambas locales       → .agents/ + .opencode/"
  echo ""

  local choice input_target ans
  prompt_tty "Selecciona [1-6]: " "Interactive mode requires a TTY. Pass an explicit mode such as --claude-global or --global."
  choice="$TTY_RESPONSE"

  case "$choice" in
    1) MODE="claude-global" ;;
    2) MODE="claude-local" ;;
    3) MODE="global" ;;
    4) MODE="local" ;;
    5) MODE="opencode" ;;
    6) MODE="both" ;;
    *) die "Opción inválida: $choice" ;;
  esac

  if [[ "$MODE" != "global" && "$MODE" != "claude-global" ]]; then
    prompt_tty "Ruta del proyecto (Enter para cwd): " "Interactive mode requires a TTY. Pass --target with an explicit mode."
    input_target="$TTY_RESPONSE"
    if [[ -n "$input_target" ]]; then
      TARGET="$input_target"
    fi
  fi

  prompt_tty "¿Modo dry-run? (mostrar sin ejecutar) [y/N]: " "Interactive mode requires a TTY. Pass --dry-run with an explicit mode."
  ans="$TTY_RESPONSE"
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    DRY_RUN=true
  fi
}

# ── Dispatch table — emits "kind:path" lines per destination
dispatch_destinations() {
  case "$MODE" in
    claude-global)
      echo "skills:${HOME}/.claude/skills"
      echo "claude-agents:${HOME}/.claude/agents"
      echo "runners:${HOME}/.local/bin"
      ;;
    claude-local)
      echo "skills:${TARGET}/.claude/skills"
      echo "claude-agents:${TARGET}/.claude/agents"
      echo "runners:${TARGET}/.claude/bin"
      ;;
    global)
      echo "skills:${HOME}/.agents/skills"
      echo "agents:${HOME}/.agents/agents"
      ;;
    local)
      echo "skills:${TARGET}/.agents/skills"
      echo "agents:${TARGET}/.agents/agents"
      ;;
    opencode)
      echo "skills:${TARGET}/.opencode/skills"
      echo "agents:${TARGET}/.opencode/agent"
      ;;
    both)
      echo "skills:${TARGET}/.agents/skills"
      echo "agents:${TARGET}/.agents/agents"
      echo "skills:${TARGET}/.opencode/skills"
      echo "agents:${TARGET}/.opencode/agent"
      ;;
  esac
}

# ── Main ────────────────────────────────────────────────────
main() {
  # Interactive if no mode specified
  if [[ -z "$MODE" ]]; then
    interactive_menu
  fi

  resolve_target
  sync_repo
  list_skills "$CACHE_DIR"
  list_agents "$CACHE_DIR"

  # Run skills + agents for each destination
  while IFS= read -r dest; do
    [[ -z "$dest" ]] && continue
    local kind="${dest%%:*}"
    local path="${dest#*:}"
    local label="${MODE} (${path})"

    if [[ "$UNINSTALL" == true ]]; then
      case "$kind" in
        skills) uninstall_from "$CACHE_DIR" "$path" "$label" ;;
        agents) uninstall_agents_from "$CACHE_DIR" "$path" "$label" ;;
        claude-agents) process_claude_agents "uninstalling" "$CACHE_DIR" "$path" "$label" ;;
        runners) process_runners "uninstalling" "$CACHE_DIR" "$path" "$label" ;;
      esac
    else
      case "$kind" in
        skills) install_to "$CACHE_DIR" "$path" "$label" ;;
        agents) install_agents_to "$CACHE_DIR" "$path" "$label" ;;
        claude-agents) process_claude_agents "installing" "$CACHE_DIR" "$path" "$label" ;;
        runners) process_runners "installing" "$CACHE_DIR" "$path" "$label" ;;
      esac
    fi
  done < <(dispatch_destinations)

  echo ""
  if [[ "$DRY_RUN" == true ]]; then
    warn "Dry-run mode: no changes were made."
  else
    ok "Done!"
  fi
}

main
