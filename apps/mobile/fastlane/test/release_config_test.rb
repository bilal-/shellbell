require 'minitest/autorun'
require 'tmpdir'
begin
  require_relative '../release_config'
rescue LoadError
end

class ReleaseConfigTest < Minitest::Test
  def test_ci_provider_authentication_precedes_build_number_allocation
    Dir.mktmpdir('ci-upload-auth-') do |dir|
      credential = File.join(dir, 'private.json'); File.write(credential, '{}')
      env = {'SHELLBELL_CONFIRM_UPLOAD'=>'internal', 'SHELLBELL_PLAY_CREDENTIALS_PATH'=>credential,
        'SHELLBELL_ASC_API_KEY_PATH'=>credential, 'SHELLBELL_ASC_APP_ID'=>'123456',
        'SHELLBELL_TESTFLIGHT_GROUP'=>'Internal'}
      %w[android ios].each do |platform|
        config = ReleaseConfig.upload_credentials(platform: platform, env: env)
        assert_equal credential, config.fetch(:credentials)
        refute config.key?(:build_number)
        assert_raises(ArgumentError) { ReleaseConfig.upload_target(platform: platform, env: env) }
        assert_raises(ArgumentError) { ReleaseConfig.upload_credentials(platform: platform, env: env.reject { |key,_| key == 'SHELLBELL_CONFIRM_UPLOAD' }) }
      end
    end
  end
  def load_config(env = {}, platform: 'android', upload: false)
    assert defined?(ReleaseConfig), 'release configuration must be implemented'
    ReleaseConfig.load(platform: platform, env: env, upload: upload)
  end

  def test_build_requires_explicit_positive_build_number_but_not_upload_secrets
    config = load_config({'SHELLBELL_BUILD_NUMBER'=>'17'})
    assert_equal 17, config.fetch(:build_number)
    assert_equal 'sh.bilal.shellbell', config.fetch(:app_id)
    refute config.key?(:credentials)
    [nil, '', '0', '-1', '1.5', '1;echo secret', '2147483648'].each do |number|
      assert_raises(ArgumentError) { load_config({'SHELLBELL_BUILD_NUMBER'=>number}) }
    end
  end

  def test_rejects_wrong_target_and_platform
    assert_raises(ArgumentError) { load_config({'SHELLBELL_BUILD_NUMBER'=>'1', 'SHELLBELL_APP_ID'=>'old.app'}) }
    assert_raises(ArgumentError) { load_config({'SHELLBELL_BUILD_NUMBER'=>'1'}, platform:'windows') }
  end

  def test_upload_requires_intent_and_existing_artifact_and_credentials
    assert_raises(ArgumentError) { load_config({'SHELLBELL_BUILD_NUMBER'=>'1'}, upload:true) }
    Dir.mktmpdir('release-config-') do |dir|
      artifact = File.join(dir, 'app.aab'); File.write(artifact, 'test artifact')
      credential = File.join(dir, 'private.json'); File.write(credential, '{}')
      env = {'SHELLBELL_BUILD_NUMBER'=>'1', 'SHELLBELL_CONFIRM_UPLOAD'=>'internal',
        'SHELLBELL_ARTIFACT'=>artifact, 'SHELLBELL_PLAY_CREDENTIALS_PATH'=>credential}
      config = load_config(env, upload:true)
      assert_equal artifact, config.fetch(:artifact)
      assert_equal credential, config.fetch(:credentials)
      assert_raises(ArgumentError) { load_config(env.merge('SHELLBELL_ARTIFACT'=>File.join(dir,'missing.aab')), upload:true) }
      assert_raises(ArgumentError) { load_config(env.merge('SHELLBELL_ARTIFACT'=>credential), upload:true) }
    end
  end

  def test_ios_requires_explicit_store_record_and_internal_group
    Dir.mktmpdir('release-ios-') do |dir|
      artifact = File.join(dir,'app.ipa'); File.write(artifact,'test artifact')
      credential = File.join(dir,'key.json'); File.write(credential,'{}')
      env = {'SHELLBELL_BUILD_NUMBER'=>'2', 'SHELLBELL_CONFIRM_UPLOAD'=>'internal',
        'SHELLBELL_ARTIFACT'=>artifact, 'SHELLBELL_ASC_API_KEY_PATH'=>credential}
      assert_raises(ArgumentError) { load_config(env, platform:'ios', upload:true) }
      config = load_config(env.merge('SHELLBELL_ASC_APP_ID'=>'123456',
        'SHELLBELL_TESTFLIGHT_GROUP'=>'Internal'), platform:'ios', upload:true)
      assert_equal '123456', config.fetch(:store_app_id)
      assert_equal 'Internal', config.fetch(:group)
    end
  end
end
