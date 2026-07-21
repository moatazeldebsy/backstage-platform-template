# frozen_string_literal: true

require 'rack/test'
require_relative '../app'

RSpec.describe '${{ values.name }}' do
  include Rack::Test::Methods

  def app
    Sinatra::Application
  end

  it 'responds ok on /healthz' do
    get '/healthz'
    expect(last_response.status).to eq(200)
    expect(JSON.parse(last_response.body)['status']).to eq('ok')
  end

  it 'responds ready on /ready' do
    get '/ready'
    expect(last_response.status).to eq(200)
    expect(JSON.parse(last_response.body)['status']).to eq('ready')
  end

  it 'responds on /' do
    get '/'
    expect(last_response.status).to eq(200)
    expect(JSON.parse(last_response.body)).to include('status')
  end

  it 'exposes prometheus metrics' do
    get '/metrics'
    expect(last_response.status).to eq(200)
  end
end
