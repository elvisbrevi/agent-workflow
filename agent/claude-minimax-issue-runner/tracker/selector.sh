#!/usr/bin/env bash
# Selects the repository-owned tracker adapter from Git remotes.
# Provider-specific validation remains inside the selected adapter.

tracker_remote_kind() {
  local url="$1"

  case "$url" in
    git@github.com:*|ssh://git@github.com/*|https://github.com/*|http://github.com/*)
      printf '%s\n' 'github'
      ;;
    https://dev.azure.com/*|http://dev.azure.com/*|https://*.visualstudio.com/*|http://*.visualstudio.com/*|ssh://*@vs-ssh.visualstudio.com/*|ssh://*@vs-ssh.visualstudio.com:v3/*|ssh://git@ssh.dev.azure.com/*|*@ssh.dev.azure.com:v3/*|*@vs-ssh.visualstudio.com:v3/*)
      printf '%s\n' 'azure-devops'
      ;;
    *)
      return 1
      ;;
  esac
}

tracker_select_adapter() {
  local repo_root="$1"
  local remote url kind selected="" count=0

  while IFS= read -r remote; do
    [[ -n "$remote" ]] || continue
    url="$(git -C "$repo_root" config --get "remote.${remote}.url" 2>/dev/null || true)"
    kind="$(tracker_remote_kind "$url" 2>/dev/null || true)"
    [[ -n "$kind" ]] || {
      printf '%s: unsupported or ambiguous tracker remote: %s (%s)\n' \
        "${RUNNER_NAME:-issue-killer}" "$remote" "${url:-missing URL}" >&2
      return 1
    }
    if [[ -n "$selected" && "$selected" != "$kind" ]]; then
      printf '%s: ambiguous tracker remotes resolve to %s and %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$selected" "$kind" >&2
      return 1
    fi
    selected="$kind"
    count=$((count + 1))
  done < <(git -C "$repo_root" remote 2>/dev/null)

  [[ "$count" -gt 0 && -n "$selected" ]] || {
    printf '%s: unable to determine a tracker from Git remotes\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  case "$selected" in
    github)
      printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/github-adapter.sh"
      ;;
    azure-devops)
      printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/azure-devops-adapter.sh"
      ;;
  esac
}
