# infra

TrailDropのインフラ関連ファイルです。

- `../supabase/migrations/` — Supabase CLIで適用するDB変更の正本です。
- `schema.sql` — SQL Editorで手動適用する場合の補助ファイルです。正本のマイグレーションと内容を同期します。
- `../supabase/config.toml` — Supabase CLIのローカル開発設定です。秘密情報は含めません。

## 適用手順

リポジトリのルートで以下を実行します。

```bash
supabase start
supabase db reset
```

既存のリモートプロジェクトへ適用する場合は、先に `supabase login` と `supabase link --project-ref <project-ref>` を実行し、その後 `supabase db push` を実行してください。

SQL Editorを使う場合は `schema.sql` を使用します。`SUPABASE_SERVICE_ROLE_KEY` や `STAFF_API_TOKEN` などの秘密情報はこのディレクトリやフロントエンドに置かず、バックエンドの `.env` だけに設定してください。

### schema.sqlとmigrationの使い分け（新規DB・既存DBどちらでも一貫させる）

- **正本は必ず `../supabase/migrations/`**。`schema.sql` はSQL Editor向けに、全migrationを適用した後と同じ状態になるよう手動で同期した補助ファイルであり、それ自体は正本ではありません。
- **同じプロジェクトに対して両方を適用しない**でください。`supabase db push`（migration経由）と `schema.sql` の手動実行は、どちらか一方だけを選びます。両方を実行しても内容は同期されているため通常は無害ですが、二重に適用する運用を続けると `schema.sql` の更新漏れに気付きにくくなります。
- 新しいmigrationを追加したら、同じ内容を `schema.sql` にも必ず反映してください（既存のmigrationファイル自体は編集しません）。
