#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# agent-workflow installer
# Clones elvisbrevi/agent-workflow and symlinks skills + agents
# into the target directory (global, local .agents/, local
# .opencode/, or both).
# ─────────────────────────────────────────────────────────────

REPO_URL="https://github.com/elvisbrevi/agent-workflow.git"
REPO_BRANCH="main"
CACHE_DIR="${HOME}/.cache/agent-workflow"
CATEGORIES=(utility discovery design planning implementation diagnosis review)
AGENT_CATEGORIES=(agent)

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

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install agent-workflow skills and agents via symlinks.

Options:
  --global              Install to ~/.agents/skills/ and ~/.agents/agents/
  --local [--target D]  Install to D/.agents/    (default: cwd)
  --opencode [--target D] Install to D/.opencode/  (skills → skills/, agents → agent/)
  --both [--target D]   Install to both local directories
  --uninstall           Remove installed symlinks
  --dry-run             Show what would be done without changes
  --force               Overwrite existing without asking
  --ref REF             Branch or tag to install from (default: main)
  -h, --help            Show this help

Examples:
  $(basename "$0")                          # Interactive menu
  $(basename "$0") --global                 # Global install
  $(basename "$0") --local --target ~/proj  # Local .agents/
  $(basename "$0") --both                   # Both local dirs in cwd
  $(basename "$0") --uninstall --global     # Remove global symlinks
  $(basename "$0") --dry-run --local        # Preview local install
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
    --global)       MODE="global"; shift ;;
    --local)        MODE="local"; shift ;;
    --opencode)     MODE="opencode"; shift ;;
    --both)         MODE="both"; shift ;;
    --target)       TARGET="$2"; shift 2 ;;
    --uninstall)    UNINSTALL=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --force)        FORCE=true; shift ;;
    --ref)          REPO_BRANCH="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "Unknown option: $1. Use --help for usage." ;;
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
      read -rp "  Overwrite? [y/N] " ans </dev/tty
      if [[ ! "$ans" =~ ^[Yy]$ ]]; then
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

  mkdir -p "$dest_base"

  local count=0
  while IFS= read -r entry; do
    local cat="${entry%%/*}"
    local skill="${entry#*/}"
    install_skill "$cache" "$dest_base" "$cat" "$skill"
    ((count++))
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
    ((count++))
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
      read -rp "  Overwrite? [y/N] " ans </dev/tty
      if [[ ! "$ans" =~ ^[Yy]$ ]]; then
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

# ── Install agents to a destination ─────────────────────────
install_agents_to() {
  local cache="$1" dest_base="$2" label="$3"

  echo ""
  echo -e "${BOLD}Installing agents → ${label}${NC}"
  echo -e "  Destination: ${dest_base}"

  mkdir -p "$dest_base"

  local count=0
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    install_agent "$cache" "$dest_base" "$agent"
    ((count++))
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

  local count=0
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    uninstall_agent "$dest_base" "$agent"
    ((count++))
  done < <(discover_agents "$cache")

  echo -e "  ${GREEN}${count} agents processed.${NC}"
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
  echo -e "  ${CYAN}1)${NC} Global              → ~/.agents/skills/ + ~/.agents/agents/"
  echo -e "  ${CYAN}2)${NC} Local .agents/      → {proyecto}/.agents/skills/ + {proyecto}/.agents/agents/"
  echo -e "  ${CYAN}3)${NC} Local .opencode/    → {proyecto}/.opencode/skills/ + {proyecto}/.opencode/agent/"
  echo -e "  ${CYAN}4)${NC} Ambas locales       → .agents/ + .opencode/"
  echo ""

  local choice
  read -rp "Selecciona [1-4]: " choice </dev/tty

  case "$choice" in
    1) MODE="global" ;;
    2) MODE="local" ;;
    3) MODE="opencode" ;;
    4) MODE="both" ;;
    *) die "Opción inválida: $choice" ;;
  esac

  if [[ "$MODE" != "global" ]]; then
    read -rp "Ruta del proyecto (Enter para cwd): " input_target </dev/tty
    if [[ -n "$input_target" ]]; then
      TARGET="$input_target"
    fi
  fi

  read -rp "¿Modo dry-run? (mostrar sin ejecutar) [y/N]: " ans </dev/tty
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    DRY_RUN=true
  fi
}

# ── Dispatch table — emits "kind:path" lines per destination
dispatch_destinations() {
  case "$MODE" in
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
      if [[ "$kind" == "skills" ]]; then
        uninstall_from "$CACHE_DIR" "$path" "$label"
      else
        uninstall_agents_from "$CACHE_DIR" "$path" "$label"
      fi
    else
      if [[ "$kind" == "skills" ]]; then
        install_to "$CACHE_DIR" "$path" "$label"
      else
        install_agents_to "$CACHE_DIR" "$path" "$label"
      fi
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
