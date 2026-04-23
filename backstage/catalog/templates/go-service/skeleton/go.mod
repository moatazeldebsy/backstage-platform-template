module github.com/${{ values.githubOrg }}/${{ values.repoName }}

go 1.22

require (
	github.com/prometheus/client_golang v1.19.1
	github.com/prometheus/common v0.55.0
)
