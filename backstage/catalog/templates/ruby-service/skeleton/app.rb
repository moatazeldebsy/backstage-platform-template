require "sinatra"
require "json"
require "logger"
require "prometheus/client"
require "prometheus/client/formatter/text"

set :bind, "0.0.0.0"
set :port, ${{ values.port }}

logger = Logger.new($stdout)

prometheus = Prometheus::Client.registry
REQUEST_COUNT = prometheus.counter(
  :http_requests_total,
  docstring: "Total HTTP requests",
  labels: [:method, :path, :status]
)
REQUEST_DURATION = prometheus.histogram(
  :http_request_duration_seconds,
  docstring: "HTTP request duration in seconds",
  labels: [:method, :path]
)

before do
  @request_start = Time.now
end

after do
  duration = Time.now - @request_start
  REQUEST_DURATION.observe(duration, labels: { method: request.request_method, path: request.path_info })
  REQUEST_COUNT.increment(labels: { method: request.request_method, path: request.path_info, status: response.status.to_s })
end

get "/healthz" do
  logger.info(JSON.generate({ msg: "healthz ok" }))
  content_type :json
  { status: "ok" }.to_json
end

get "/ready" do
  content_type :json
  { status: "ready" }.to_json
end

get "/metrics" do
  content_type "text/plain"
  Prometheus::Client::Formatter::Text.new.call(prometheus)
end

get "/" do
  logger.info(JSON.generate({ msg: "root called" }))
  content_type :json
  { service: "${{ values.name }}", status: "running" }.to_json
end
