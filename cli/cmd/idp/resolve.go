package main

import (
	"fmt"
	"os"
	"strings"
)

const (
	envLocal = "local"
	envAWS   = "aws"
)

// resolveBackstageURL returns the Backstage base URL for the given environment.
// explicit (the --backstage-url flag value) always wins.
// For --env aws probes in order:
//
//	IDP_BACKSTAGE_URL env → BACKSTAGE_URL env → https://backstage.<IDP_DOMAIN>
//	→ local/.env keys IDP_BACKSTAGE_URL / BACKSTAGE_URL
//	→ warns and falls back to http://backstage.idp.local
func resolveBackstageURL(env, explicit, root string) string {
	if explicit != "" {
		return strings.TrimRight(explicit, "/")
	}
	if env == envAWS {
		for _, key := range []string{"IDP_BACKSTAGE_URL", "BACKSTAGE_URL"} {
			if u := os.Getenv(key); u != "" {
				return strings.TrimRight(u, "/")
			}
		}
		if d := os.Getenv("IDP_DOMAIN"); d != "" {
			return "https://backstage." + strings.TrimLeft(d, ".")
		}
		for _, key := range []string{"IDP_BACKSTAGE_URL", "BACKSTAGE_URL"} {
			if u := keyFromEnvFile(root+"/local/.env", key); u != "" {
				return strings.TrimRight(u, "/")
			}
		}
		fmt.Fprintln(os.Stderr, "[idp] Warning: --env aws but no Backstage URL found; "+
			"set IDP_BACKSTAGE_URL, BACKSTAGE_URL, IDP_DOMAIN, or --backstage-url")
	}
	return "http://backstage.idp.local"
}

// resolveToken returns the Backstage service token for the given environment.
//
// For --env local (priority order):
//
//	--token flag → BACKSTAGE_TOKEN env → BACKSTAGE_AUTH_SECRET in local/backstage/.env
//	→ static token in backstage/app-config.local.yaml
//
// For --env aws (priority order):
//
//	--token flag → BACKSTAGE_TOKEN env → IDP_BACKSTAGE_TOKEN env
//	→ BACKSTAGE_TOKEN / IDP_BACKSTAGE_TOKEN in local/.env
func resolveToken(env, explicit, root string) string {
	if explicit != "" {
		return explicit
	}
	if t := os.Getenv("BACKSTAGE_TOKEN"); t != "" {
		return t
	}
	if env == envAWS {
		if t := os.Getenv("IDP_BACKSTAGE_TOKEN"); t != "" {
			return t
		}
		for _, key := range []string{"BACKSTAGE_TOKEN", "IDP_BACKSTAGE_TOKEN"} {
			if t := keyFromEnvFile(root+"/local/.env", key); t != "" {
				return t
			}
		}
		return ""
	}
	// local: docker-compose env file and static config
	if t := keyFromEnvFile(root+"/local/backstage/.env", "BACKSTAGE_AUTH_SECRET"); t != "" {
		return t
	}
	if t := staticTokenFromConfig(root + "/backstage/app-config.local.yaml"); t != "" {
		fmt.Printf("[idp] Using static token from app-config.local.yaml\n")
		return t
	}
	return ""
}
