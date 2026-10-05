module ReleaseConfig
  APP_ID = 'sh.bilal.shellbell'.freeze

  def self.required(env, key)
    value = env[key]
    raise ArgumentError, "Missing #{key}" unless value.is_a?(String) && !value.strip.empty?
    value
  end

  def self.file(env, key, extension = nil)
    path = File.expand_path(required(env, key))
    raise ArgumentError, "Unreadable #{key}" unless File.file?(path) && File.readable?(path)
    raise ArgumentError, "Wrong artifact type for #{key}" if extension && File.extname(path) != extension
    path
  end

  def self.identity(platform:, env:)
    raise ArgumentError, 'Unsupported platform' unless %w[android ios].include?(platform)
    app_id = env.fetch('SHELLBELL_APP_ID', APP_ID)
    raise ArgumentError, 'Unexpected app ID' unless app_id == APP_ID
    {app_id: app_id}
  end

  def self.load(platform:, env:, upload: false, artifact: nil)
    config = identity(platform: platform, env: env)
    text = required(env, 'SHELLBELL_BUILD_NUMBER')
    raise ArgumentError, 'Invalid build number' unless text.match?(/\A[1-9][0-9]*\z/) && text.to_i <= 2_100_000_000
    config[:build_number] = text.to_i
    return config unless upload

    config.merge!(upload_credentials(platform: platform, env: env))
    artifact_env = artifact ? env.to_h.merge('SHELLBELL_ARTIFACT' => artifact) : env
    config[:artifact] = file(artifact_env, 'SHELLBELL_ARTIFACT', platform == 'android' ? '.aab' : '.ipa')
    config
  end

  # Validate the destination before building, when the artifact does not exist yet.
  def self.upload_target(platform:, env:)
    load(platform: platform, env: env).merge(upload_credentials(platform: platform, env: env))
  end

  # Provider authentication must be available before CI allocates a build number.
  def self.upload_credentials(platform:, env:)
    config = identity(platform: platform, env: env)

    raise ArgumentError, 'Set SHELLBELL_CONFIRM_UPLOAD=internal for an explicit upload' unless env['SHELLBELL_CONFIRM_UPLOAD'] == 'internal'
    config[:credentials] = file(env, platform == 'android' ? 'SHELLBELL_PLAY_CREDENTIALS_PATH' : 'SHELLBELL_ASC_API_KEY_PATH')
    if platform == 'ios'
      app = required(env, 'SHELLBELL_ASC_APP_ID')
      raise ArgumentError, 'Invalid App Store Connect app ID' unless app.match?(/\A[1-9][0-9]*\z/)
      config[:store_app_id] = app
      config[:group] = required(env, 'SHELLBELL_TESTFLIGHT_GROUP')
      encryption = env['SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION']
      unless encryption.nil?
        raise ArgumentError, 'SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION must be true or false' unless %w[true false].include?(encryption)
        config[:uses_non_exempt_encryption] = encryption == 'true'
      end
    end
    config
  end

  def self.built_artifact(platform:)
    relative = case platform
      when 'android' then '../android/app/build/outputs/bundle/release/app-release.aab'
      when 'ios' then '../output/ios/Shellbell.ipa'
      else raise ArgumentError, 'Unsupported platform'
    end
    File.expand_path(relative, __dir__)
  end
end
