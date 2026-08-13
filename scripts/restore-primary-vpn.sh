#!/usr/bin/env bash
#
# VPN ルーター上で実行し、fail-primary-vpn.sh が追加した iptables ルールだけを
# 削除して primary 側 Site-to-Site VPN (2 トンネル) を復旧する。
#
# このスクリプトは VPN ルーター上で実行する。ルーターが 2 台ある (jp 用 / us 用) ため、
# 実行したルーターが担当するオンプレミス相当ネットワークのプレフィックスだけが
# 影響を受ける (もう一方のルーター・ペアには影響しない)。
#
# --comment (cloudwan-fail-primary-vpn) が付いたルールのみを対象にし、
# iptables 全体を flush しない (他の既存ルールに影響を与えないため)。
#
set -uo pipefail

COMMENT="cloudwan-fail-primary-vpn"

MATCHED=$(iptables -S | grep -- "${COMMENT}" || true)

if [ -z "${MATCHED}" ]; then
  echo "削除対象の iptables ルール (${COMMENT}) が見つからない。すでに復旧済みの可能性がある"
else
  # `iptables -S` の "-A <chain> ..." 形式を "-D <chain> ..." に置き換えて
  # 同一条件で削除する (追加時と完全に同じマッチ条件でしか安全に削除できないため)。
  while IFS= read -r rule; do
    [ -z "${rule}" ] && continue
    del_rule="${rule/#-A/-D}"
    echo "削除: iptables ${del_rule}"
    eval "iptables ${del_rule}"
  done <<< "${MATCHED}"
fi

echo
echo "=== 残存する ${COMMENT} ルール (空であるべき) ==="
iptables -S | grep -- "${COMMENT}" || echo "(なし)"
echo
echo "=== ipsec status (established 数) ==="
ipsec status | grep -c established || true
