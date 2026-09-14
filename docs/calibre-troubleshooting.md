# Calibre トラブルシューティング

Calibre Interactive (nmLVS など) 利用時に遭遇したエラーと対処法を記録する。

## Could not read included file in source netlist

**発生状況**

Calibre Interactive (nmLVS) で LVS を実行した際、Transcript ウィンドウに以下のエラーが表示される。

```
INFO: Verifying the source netlist is complete before starting the run
ERROR: Could not read included file in source netlist:
  /projsc22/private/analog/data/iPDK_Cadence_CRN22ULL/Calibre/lvs/source.added/
```

「Warning」ダイアログでも同内容が表示され、`Proceed` / `Stop LVS` の選択を求められる。

**原因**

ソースネットリスト (`.sp` ファイル) が include している `source.added` ファイルのパスが、
Cadence 側のエクスポート設定と一致していないために読み込めていない。

**対処法**

1. Cadence の Library をエクスポートしたウィンドウで以下を開く。
   `File > Export > Netlist > Netlister Options > Include Files`
2. そこに指定されているファイル名(パス)が正しいかを確認する。
   - 特に `source.added` のパスが実際に存在する場所と一致しているかをチェックする。
3. パスが誤っている、もしくは存在しないファイルを指している場合は修正して再エクスポートする。
4. 再度 Calibre Interactive で nmLVS を実行し、エラーが解消されているか確認する。
