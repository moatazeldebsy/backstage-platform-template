#!/usr/bin/env bash
# Seed the contract registry with the demo data needed for the WeAreDevelopers talk.
# Run this once after bootstrap-ai.sh, before recording the screencast or going on stage.
#
# What it does:
#   1. Registers payments-api v1.0.0 (the provider, happy-state spec — currency field present)
#   2. Registers payments-svc v1.0.0 (consumer — reads currency in 4 places)
#   3. Registers billing-export v1.0.0 (consumer — maps currency to ledger)
#
# After this script:
#   can_i_deploy payments-api/1.0.0 → safe: true (all consumers satisfied)
#   Remove currency from payments-api spec → safe: false (2 consumers blocked)

set -euo pipefail

SERVER="${CONTRACT_SERVER_URL:-http://contract-mcp-server.idp.local}"

log() { echo "  → $*"; }
ok()  { echo "  ✓ $*"; }

echo ""
echo "Contract Demo Seed"
echo "Server: $SERVER"
echo ""

# ── 1. payments-api v1.0.0 (provider, happy state) ───────────────────────────

log "Registering payments-api v1.0.0 (provider)..."

PAYMENTS_API_SPEC=$(cat <<'EOF'
{
  "openapi": "3.1.0",
  "info": { "title": "Payments API", "version": "1.0.0" },
  "paths": {
    "/api/accounts/{account_id}": {
      "get": {
        "summary": "Get account details",
        "parameters": [{ "name": "account_id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": {
          "200": {
            "description": "Account",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "id":       { "type": "string" },
                    "owner":    { "type": "string" },
                    "balance":  { "type": "number" },
                    "currency": { "type": "string" }
                  },
                  "required": ["id", "owner", "balance", "currency"]
                }
              }
            }
          }
        }
      }
    },
    "/api/transactions": {
      "get": {
        "summary": "List transactions",
        "responses": {
          "200": {
            "description": "Transactions",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id":         { "type": "string" },
                      "amount":     { "type": "number" },
                      "currency":   { "type": "string" },
                      "status":     { "type": "string" },
                      "account_id": { "type": "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/payments": {
      "post": {
        "summary": "Process a payment",
        "responses": { "201": { "description": "Created" } }
      }
    }
  }
}
EOF
)

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SERVER/api/contracts/payments-api/1.0.0" \
  -H "Content-Type: application/json" \
  -d "$PAYMENTS_API_SPEC")
[ "$HTTP" = "200" ] && ok "payments-api v1.0.0 registered" || { echo "  ✗ Failed (HTTP $HTTP)"; exit 1; }

# ── 2. payments-svc v1.0.0 (consumer — reads currency in 4 places) ───────────

log "Registering payments-svc v1.0.0 (consumer)..."

PAYMENTS_SVC_SPEC=$(cat <<'EOF'
{
  "openapi": "3.1.0",
  "info": { "title": "Payments SVC (consumer contract)", "version": "1.0.0" },
  "paths": {
    "/api/accounts/{account_id}": {
      "get": {
        "summary": "Account details consumed by payments-svc",
        "description": "payments-svc reads order.currency in 4 places: display, FX conversion, reporting, and ledger entry.",
        "parameters": [{ "name": "account_id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": {
          "200": {
            "description": "Account",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "id":       { "type": "string" },
                    "currency": { "type": "string" }
                  },
                  "required": ["id", "currency"]
                }
              }
            }
          }
        }
      }
    }
  }
}
EOF
)

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SERVER/api/contracts/payments-svc/1.0.0" \
  -H "Content-Type: application/json" \
  -d "$PAYMENTS_SVC_SPEC")
[ "$HTTP" = "200" ] && ok "payments-svc v1.0.0 registered" || { echo "  ✗ Failed (HTTP $HTTP)"; exit 1; }

# ── 3. billing-export v1.0.0 (consumer — maps currency to ledger) ────────────

log "Registering billing-export v1.0.0 (consumer)..."

BILLING_EXPORT_SPEC=$(cat <<'EOF'
{
  "openapi": "3.1.0",
  "info": { "title": "Billing Export (consumer contract)", "version": "1.0.0" },
  "paths": {
    "/api/accounts/{account_id}": {
      "get": {
        "summary": "Account details consumed by billing-export",
        "description": "billing-export maps order.currency to the ledger entry.",
        "parameters": [{ "name": "account_id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": {
          "200": {
            "description": "Account",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "id":       { "type": "string" },
                    "currency": { "type": "string" }
                  },
                  "required": ["id", "currency"]
                }
              }
            }
          }
        }
      }
    }
  }
}
EOF
)

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SERVER/api/contracts/billing-export/1.0.0" \
  -H "Content-Type: application/json" \
  -d "$BILLING_EXPORT_SPEC")
[ "$HTTP" = "200" ] && ok "billing-export v1.0.0 registered" || { echo "  ✗ Failed (HTTP $HTTP)"; exit 1; }

# ── Verify ────────────────────────────────────────────────────────────────────

echo ""
echo "Verifying..."
CONTRACTS=$(curl -s "$SERVER/api/contracts" | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(f'  {x[\"serviceName\"]}' for x in d))" 2>/dev/null || echo "  (parse error — check manually)")
echo "Registered contracts:"
echo "$CONTRACTS"

echo ""
CAN_DEPLOY=$(curl -s "$SERVER/api/can-i-deploy/payments-api/1.0.0")
SAFE=$(echo "$CAN_DEPLOY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('safe','?'))" 2>/dev/null)
echo "can_i_deploy payments-api/1.0.0 → safe: $SAFE"
[ "$SAFE" = "True" ] || [ "$SAFE" = "true" ] \
  && ok "Ready for Beat 1 (happy path)" \
  || echo "  ✗ Expected safe:true — check consumer specs"

echo ""
echo "Demo seed complete. Next steps:"
echo "  1. Open /ai-assistant in Backstage → select contract-assistant"
echo "  2. Beat 1 prompt: 'Can I deploy payments-api version 1.0.0?'"
echo "  3. Edit services/payments-api/src/main.py — rename currency → currencyCode in Account model"
echo "  4. Re-register the broken spec (see scripts/break-payments-api.sh)"
echo "  5. Beat 3 prompt: 'Can I deploy payments-api version 1.1.0?'"
echo ""
