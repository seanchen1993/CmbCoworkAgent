#!/usr/bin/env bash
# Narrow correction of the two already repaired, non-secret system configs.
set -Eeuo pipefail
task_owner=${1:?owner UUID required}
[[ "$task_owner" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]
[[ $(id -u) = 0 && $(hostname) = colima-devclaw-bot ]]
backup=/var/lib/devclaw-bot-b00-dns-$task_owner
[[ -d "$backup" && ! -L "$backup" && $(stat -c '%u %a' "$backup") = '0 700' ]]
[[ $(cat "$backup/owner") = "$task_owner" ]]
for path in /etc/resolv.conf /etc/dnsmasq.d/01-colima.conf; do
  [[ -f "$path" && ! -L "$path" && $(stat -c '%u %h %a' "$path") = '0 1 600' ]]
done
[[ $(sha256sum /etc/resolv.conf | awk '{print $1}') = 64f78010f6cdecf0169c0a5a540ba0668bd43e970b64872fc3b632c48469b0ae ]]
[[ $(sha256sum /etc/dnsmasq.d/01-colima.conf | awk '{print $1}') = 439a9eb6eb5f957f2dc088ca4d7e5b954cf2a1c6a7a4da946af362f482719251 ]]
chmod 644 -- /etc/resolv.conf /etc/dnsmasq.d/01-colima.conf
stat -c '%a %u %F %n' /etc/resolv.conf /etc/dnsmasq.d/01-colima.conf
