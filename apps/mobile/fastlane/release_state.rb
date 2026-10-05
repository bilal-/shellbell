require 'json'
require 'digest'

# Provider state owns native build counters; marketing versions come from source.
module ReleaseState
  MAX_BUILD = 2_100_000_000

  def self.next_number(values)
    numbers = values.map do |value|
      text = value.to_s
      raise 'Unexpected store build number' unless text.match?(/\A[1-9][0-9]*\z/) && text.to_i <= MAX_BUILD
      text.to_i
    end
    number = (numbers.max || 0) + 1
    raise 'Store build counter exhausted' if number > MAX_BUILD
    number
  end

  def self.android_client(path)
    require 'google/apis/androidpublisher_v3'
    require 'googleauth'
    client = Google::Apis::AndroidpublisherV3::AndroidPublisherService.new
    File.open(path) do |credentials|
      client.authorization = Google::Auth::ServiceAccountCredentials.make_creds(
        json_key_io: credentials, scope: 'https://www.googleapis.com/auth/androidpublisher')
    end
    client
  end

  def self.next_android(client, app_id)
    edit = client.insert_edit(app_id)
    raise 'Missing Play edit ID' unless edit&.id
    begin
      bundles = client.list_edit_bundles(app_id, edit.id).bundles || []
      apks = client.list_edit_apks(app_id, edit.id).apks || []
      tracks = client.list_edit_tracks(app_id, edit.id).tracks || []
      numbers = bundles.map(&:version_code) + apks.map(&:version_code)
      tracks.each { |track| (track.releases || []).each { |release| numbers.concat(release.version_codes || []) } }
      next_number(numbers)
    ensure
      client.delete_edit(app_id, edit.id)
    end
  end

  def self.next_ios(app)
    # Spaceship's app-scoped get_builds follows every response page, including
    # expired and processing builds. Accepted numbers must never be reused.
    next_number(app.get_builds.map(&:version))
  end

  def self.marketing_version
    package = JSON.parse(File.read(File.expand_path('../package.json', __dir__)))
    version = package.fetch('version')
    raise 'Invalid source marketing version' unless version.match?(/\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z/)
    version
  end

  def self.android_signing(env)
    config = JSON.parse(File.read(ReleaseConfig.file(env, 'SHELLBELL_ANDROID_SIGNING_CONFIG', '.json')))
    %w[key_alias store_password key_password].each { |key| ReleaseConfig.required(config, key) }
    env['SHELLBELL_ANDROID_KEY_ALIAS'] = config.fetch('key_alias')
    env['SHELLBELL_ANDROID_STORE_PASSWORD'] = config.fetch('store_password')
    env['SHELLBELL_ANDROID_KEY_PASSWORD'] = config.fetch('key_password')
  end

  def self.receipt(platform, env)
    path = ReleaseConfig.required(env, 'SHELLBELL_RELEASE_RECEIPT')
    source = ReleaseConfig.required(env, 'SHELLBELL_RELEASE_SOURCE_SHA')
    raise 'Invalid source commit' unless source.match?(/\A[0-9a-f]{40}\z/)
    artifact = ReleaseConfig.built_artifact(platform: platform)
    number = ReleaseConfig.load(platform: platform, env: env).fetch(:build_number)
    record = {schemaVersion: 1, platform: platform, version: marketing_version,
      buildNumber: number, sourceCommit: source, artifactSha256: Digest::SHA256.file(artifact).hexdigest,
      destination: platform == 'ios' ? 'TestFlight internal' : 'Google Play internal', storeAssignmentVerified: true}
    File.write(path, JSON.pretty_generate(record) + "\n", perm: 0600)
    File.open(env.fetch('GITHUB_OUTPUT'), 'a') { |file| file.puts("build_number=#{number}") } if env['GITHUB_OUTPUT']
    record
  end
end
