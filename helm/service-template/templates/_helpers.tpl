{{/*
Expand the name of the chart.
*/}}
{{- define "service-template.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "service-template.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label.
*/}}
{{- define "service-template.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "service-template.labels" -}}
helm.sh/chart: {{ include "service-template.chart" . }}
{{ include "service-template.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "service-template.selectorLabels" -}}
app.kubernetes.io/name: {{ include "service-template.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "service-template.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "service-template.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Analysis block shared by the canary steps and the blue-green pre/post hooks.
Thresholds come from values so the ClusterAnalysisTemplate can stay a single
cluster-scoped resource with per-service numbers passed as args.
*/}}
{{- define "service-template.rollout.analysis" -}}
templates:
  - clusterScope: {{ .Values.rollout.analysis.clusterScope }}
    templateName: {{ .Values.rollout.analysis.templateName }}
args:
  - name: service-name
    value: {{ include "service-template.fullname" . }}
  - name: namespace
    value: {{ .Release.Namespace }}
  - name: error-rate-threshold
    value: {{ .Values.rollout.analysis.errorRateThreshold | quote }}
  - name: latency-threshold
    value: {{ .Values.rollout.analysis.latencyThresholdSeconds | quote }}
{{- end }}

{{/*
Canary steps. Renders values.rollout.canary.steps when set, expanding any
`analysis: {}` marker into the full templates+args block. Falls back to the
legacy 20 -> analysis -> 50 -> analysis -> 100 shape so overlays written against
the old three-key schema keep producing an identical Rollout.
*/}}
{{- define "service-template.rollout.canarySteps" -}}
{{- $ctx := . -}}
{{- if .Values.rollout.canary.steps -}}
{{- range .Values.rollout.canary.steps }}
{{- if hasKey . "analysis" }}
- analysis:
    {{- include "service-template.rollout.analysis" $ctx | nindent 4 }}
{{- else }}
- {{ toYaml . | nindent 2 | trim }}
{{- end }}
{{- end }}
{{- else -}}
- setWeight: {{ .Values.rollout.canary.initialWeight }}
- pause:
    duration: {{ .Values.rollout.canary.step1PauseDuration }}
{{- if .Values.rollout.analysis.enabled }}
- analysis:
    {{- include "service-template.rollout.analysis" $ctx | nindent 4 }}
{{- end }}
- setWeight: 50
- pause:
    duration: {{ .Values.rollout.canary.step2PauseDuration }}
{{- if .Values.rollout.analysis.enabled }}
- analysis:
    {{- include "service-template.rollout.analysis" $ctx | nindent 4 }}
{{- end }}
{{- end }}
{{- end }}
