# evidence/ 内のファイル名の凡例

各ファイル名は要素をハイフンで連結したものです。`20260812/` と `20260813/` はそれぞれ実機確認を行った日付です。

## stage (状態)

| トークン | 意味 |
|---|---|
| `baseline` | Routing Policy 未適用 |
| `policy1` | 最初に投入した prepend 方式。match 条件が secondary CNE の ASN 1 つだけで、secondary 自身が発信元の経路まで誤って対象にするバグがあった |
| `policy2` | policy1 のバグを、secondary CNE の ASN とオンプレミスルーターの ASN の 2 条件 AND に直して修正した prepend 方式 |
| `policy2-lp` | policy2 に加えて、オンプレミス側 FRR の `set-return-path.sh` で戻り方向の local preference を primary に設定した状態 |

**`policy2-lp` の LP は Cloud WAN Routing Policy の `set-local-preference` ではありません。** `ROUTING_POLICY_MODE` はこの検証を通じて `prepend` のままで、Cloud WAN 側の `localPreference` モードは一度もデプロイしていません (詳細は `../README.md` の「検証結果」節を参照)。ここでの LP は、オンプレミス側 VPN ルーターの FRR が `set-return-path.sh` で設定する、戻り方向 (オンプレミスから AWS へ向かう向き) にのみ効く BGP local preference です。

## event (操作)

| トークン | 意味 |
|---|---|
| `use1-tgw-detach` | use1 (バージニア北部) の TGW の Cloud WAN アタッチメントを削除した状態 |
| `use1-tgw-detach-restore` | 上記アタッチメントを削除後に再作成した状態 |

## 種別

| トークン | 意味 |
|---|---|
| `fib` | `./scripts/get-fib.sh` の出力 |
| `rib` | `./scripts/get-rib.sh` の出力 |
| `corepolicy` | その時点で投入していた Core Network Policy の JSON |
| `us-router` | バージニア北部オンプレミス相当 VPN ルーター上でのコマンド出力 |
| `jp-router` | 東京オンプレミス相当 VPN ルーター上でのコマンド出力 |
| `ip-list` | IP アドレス一覧 |
| `resource-list` | 各種リソース一覧 |
