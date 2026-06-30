#!/usr/bin/env bash
# Registers the "broken" payments-api v1.1.0 spec (currency renamed to currencyCode).
# Run this during Beat 2 of the demo AFTER showing the openapi diff.
# This is what triggers safe: false in Beat 3.

set -euo pipefail

SERVER="${CONTRACT_SERVER_URL:-http://contract-mcp-server.idp.local}"

echo ""
echo "Registering payments-api v1.1.0 (breaking change: currency → currencyCode)..."

BROKEN_SPEC=$(cat <<'EOF'
{
  "openapi": "3.1.0",
  "info": { "title": "Payments API", "version": "1.1.0" },
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
                    "id":           { "type": "string" },
                    "owner":        { "type": "string" },
                    "balance":      { "type": "number" },
                    "currencyCode": { "type": "string" }
                  },
                  "required": ["id", "owner", "balance", "currencyCode"]
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
        "responses": { "200": { "description": "Transactions" } }
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
  "$SERVER/api/contracts/payments-api/1.1.0" \
  -H "Content-Type: application/json" \
  -d "$BROKEN_SPEC")

[ "$HTTP" = "200" ] && echo "  ✓ payments-api v1.1.0 registered (broken)" || { echo "  ✗ Failed (HTTP $HTTP)"; exit 1; }

echo ""
echo "Now ask the agent: 'Can I deploy payments-api version 1.1.0?'"
echo "Expected: safe: false — 2 consumers blocked (payments-svc, billing-export)"
echo ""
