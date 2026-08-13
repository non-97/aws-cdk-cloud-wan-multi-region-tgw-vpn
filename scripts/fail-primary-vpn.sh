#!/usr/bin/env bash
#
# VPN ルーター上で実行し、primary 側 Site-to-Site VPN (2 トンネル) を落とす。
#
# このスクリプトは VPN ルーター上で実行する。ルーターが 2 台ある (jp 用 / us 用) ため、
# 実行したルーターが担当するオンプレミス相当ネットワークのプレフィックスだけが
# 影響を受ける (もう一方のルーター・ペアには影響しない)。
#
# FRR の "neighbor shutdown" は使わない。shutdown は BGP セッションだけを
# 落とすため IPsec (IKE/ESP) は UP のまま残り、describe-vpn-connections の
# VgwTelemetry[].Status は UP を返し続ける。検証したいのは
# 「Site-to-Site VPN がダウンした場合」の挙動なので、証跡 (VgwTelemetry)
# と実際の状態を一致させるために IPsec のトンネル自体を iptables で遮断する。
#
# primary 側 2 トンネルの外側 IP (/etc/vpn-router-outside-ips.env の
# PRIMARY_OUTSIDE_IPS) 宛 / 発の udp/500 (IKE), udp/4500 (NAT-T), esp を
# DROP する。ルールには --comment を付け、restore-primary-vpn.sh が
# 同じルールだけを削除できるようにする (iptables 全体を flush しない)。
#
set -uo pipefail

OUTSIDE_IPS_FILE=/etc/vpn-router-outside-ips.env
if [ ! -f "${OUTSIDE_IPS_FILE}" ]; then
  echo "ERROR: ${OUTSIDE_IPS_FILE} が見つからない (vpn-router-bootstrap.sh が未完了)" >&2
  exit 1
fi

# shellcheck source=/etc/vpn-router-outside-ips.env
source "${OUTSIDE_IPS_FILE}"

: "${PRIMARY_OUTSIDE_IPS:?PRIMARY_OUTSIDE_IPS is required (from ${OUTSIDE_IPS_FILE})}"

read -r -a PRIMARY_IP_ARRAY <<< "${PRIMARY_OUTSIDE_IPS}"
if [ "${#PRIMARY_IP_ARRAY[@]}" -ne 2 ]; then
  echo "ERROR: PRIMARY_OUTSIDE_IPS は2つの IP であること (got: ${PRIMARY_OUTSIDE_IPS})" >&2
  exit 1
fi

COMMENT="cloudwan-fail-primary-vpn"

for ip in "${PRIMARY_IP_ARRAY[@]}"; do
  # primary の外側 IP からの着信 (IKE / NAT-T / ESP)
  iptables -I INPUT -s "${ip}" -p udp --sport 500 -m comment --comment "${COMMENT}" -j DROP
  iptables -I INPUT -s "${ip}" -p udp --sport 4500 -m comment --comment "${COMMENT}" -j DROP
  iptables -I INPUT -s "${ip}" -p esp -m comment --comment "${COMMENT}" -j DROP

  # primary の外側 IP への発信 (IKE / NAT-T / ESP)
  iptables -I OUTPUT -d "${ip}" -p udp --dport 500 -m comment --comment "${COMMENT}" -j DROP
  iptables -I OUTPUT -d "${ip}" -p udp --dport 4500 -m comment --comment "${COMMENT}" -j DROP
  iptables -I OUTPUT -d "${ip}" -p esp -m comment --comment "${COMMENT}" -j DROP
done

echo "primary 側 2 トンネル (${PRIMARY_IP_ARRAY[*]}) 宛 / 発の IKE/NAT-T/ESP を DROP した"
echo
echo "=== 追加した iptables ルール (${COMMENT}) ==="
iptables -S | grep -- "${COMMENT}"
echo
echo "=== ipsec status (established 数) ==="
ipsec status | grep -c established || true
