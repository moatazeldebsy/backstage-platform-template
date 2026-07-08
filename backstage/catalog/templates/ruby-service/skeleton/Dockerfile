FROM ruby:3.3-slim

WORKDIR /app

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY Gemfile Gemfile.lock* ./
RUN bundle config set without 'development test' \
    && bundle install --jobs 4 --retry 3

COPY app.rb config.ru ./

# Run as non-root (Trivy DS-0002 / container hardening)
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE ${{ values.port }}

CMD ["bundle", "exec", "puma", "-p", "${{ values.port }}", "-e", "production"]
