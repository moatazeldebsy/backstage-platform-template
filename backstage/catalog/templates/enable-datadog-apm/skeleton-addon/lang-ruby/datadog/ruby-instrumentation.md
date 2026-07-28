# Ruby — datadog gem setup

1. Add the gem to your `Gemfile`:

   ```ruby
   gem 'datadog'
   ```

2. Configure the tracer, typically in an initializer (e.g. `config/initializers/datadog.rb` for
   Rails):

   ```ruby
   require 'datadog/auto_instrument'

   Datadog.configure do |c|
     c.tracing.enabled = true
   end
   ```

3. Set the env vars from `datadog/README.md` (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_SITE`,
   `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`).
