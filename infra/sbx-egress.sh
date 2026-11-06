#!/usr/bin/env bash
# Second network wall, independent of the microVM's no-NIC setting. Everything run by uid `sbx`
# (the runner and every microVM process) is refused new outbound connections. Replies to the
# control plane's inbound requests still work. Adapted from Nusa's infra/sbx-egress.sh.
#
# The jump goes FIRST in OUTPUT and must be applied after ufw. ufw's own chains accept NEW outbound
# connections, so a rule placed below them never fires. checker/redteam.py wall_two_test exists to
# catch exactly this: it opens wall 1 on purpose and requires the rejected-packet counter to rise.
set -euo pipefail
VPC_CIDR="${VPC_CIDR:-10.77.0.0/24}"
UID_SBX="$(id -u sbx)"
CHAIN=SBX-EGRESS

for ipt in iptables ip6tables; do
  "$ipt" -N "$CHAIN" 2>/dev/null || "$ipt" -F "$CHAIN"
  while "$ipt" -D OUTPUT -m owner --uid-owner "$UID_SBX" -j "$CHAIN" 2>/dev/null; do :; done
  "$ipt" -I OUTPUT 1 -m owner --uid-owner "$UID_SBX" -j "$CHAIN"
  "$ipt" -A "$CHAIN" -o lo -j ACCEPT
  "$ipt" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done

# Named rules first, so the counters say what was attempted.
iptables -A "$CHAIN" -d 169.254.169.254/32 -j REJECT --reject-with icmp-port-unreachable
iptables -A "$CHAIN" -d "$VPC_CIDR" -j REJECT --reject-with icmp-port-unreachable
iptables -A "$CHAIN" -j REJECT --reject-with icmp-port-unreachable
ip6tables -A "$CHAIN" -j REJECT --reject-with icmp6-port-unreachable

iptables -S OUTPUT | head -3
iptables -S "$CHAIN"
