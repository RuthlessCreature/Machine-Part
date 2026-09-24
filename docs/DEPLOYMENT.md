# Production deployment — ikun.homes

## Target

- Worker: `machine-part`
- Custom Domain: `ikun.homes`
- D1: `machine-part`
- R2: `machine-part-artifacts`
- AI: MiniMax M3 Token Plan
- Compute: Cloudflare Container running OpenCascade/CadQuery

## GitHub repository secrets

The manual `Deploy Cloudflare` Action requires:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MINIMAX_API_KEY`

Do not commit any of these values.

For first deployment, the Cloudflare API token must be able to create the Worker and the D1/R2 resources and to attach the Custom Domain. Use least privilege where possible:
- Workers product: Admin for first Worker creation; Editor is enough for later deployments.
- Zone `ikun.homes`: Workers Routes Write.
- D1/R2: permissions sufficient to create/list the production D1 database and R2 bucket.

## Deployment behavior

The workflow:
1. installs dependencies;
2. finds or creates D1 `machine-part`;
3. patches the D1 UUID into the in-run copy of `wrangler.jsonc`;
4. finds or creates R2 `machine-part-artifacts`;
5. applies D1 migrations;
6. builds the React front end and type-checks the Worker;
7. runs `wrangler deploy`, including the CAD Container;
8. installs `MINIMAX_API_KEY` as a Worker secret;
9. checks `https://ikun.homes/api/health`.

The committed config keeps `database_id: REPLACE_ME` intentionally so an unauthenticated/manual deploy cannot accidentally target the wrong database. The CI workflow patches it only in the ephemeral Actions workspace.

## Domain constraint

Cloudflare Custom Domains cannot take over a hostname that has a conflicting CNAME. If `ikun.homes` already has a conflicting DNS record or route, the deploy will stop rather than delete it automatically. Resolve the conflict explicitly before rerunning.

## Production caveat

MiniMax's Token Plan is designed primarily for individual/interactive development and can be dynamically rate-limited. This project can use it as requested, but multi-user production should keep a pay-as-you-go fallback or a bounded retry/backoff policy.
