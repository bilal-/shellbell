require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require 'open3'
require 'rbconfig'

class LaneHarness
  attr_reader :lanes, :calls
  attr_accessor :ipa_id, :built_artifact, :build_error, :node_build_probe
  def initialize
    @lanes = {}; @calls = []
  end
  def default_platform(*) = nil
  def opt_out_usage = nil
  def desc(*) = nil
  def platform(name, &block)
    @platform = name
    instance_eval(&block)
  end
  def lane(name, &block) = @lanes[[@platform,name]] = block
  def run(platform,name,options = {})
    previous = @platform
    @platform = platform
    instance_exec(options, &@lanes.fetch([platform,name]))
  ensure
    @platform = previous
  end
  def method_missing(name, *args)
    return run(@platform, name, args.first || {}) if @lanes.key?([@platform,name])
    super
  end
  def respond_to_missing?(name, include_private = false)
    @lanes.key?([@platform,name]) || super
  end
  def sh(*args, **options)
    @calls << [:sh,args,options]
    if args.first == 'node'
      @node_build_probe.call if @node_build_probe
      raise @build_error if @build_error
      File.write(@built_artifact, 'fresh build') if @built_artifact && args.include?('android')
    end
    return '7' if args.any? { |arg| arg.to_s.include?('@android:versionCode') }
    return ReleaseState.marketing_version if args.any? { |arg| arg.to_s.include?('@android:versionName') }
    'sh.bilal.shellbell'
  end
  def build_app(**options)
    @calls << [:build_app,options]
    raise @build_error if @build_error
    File.write(@built_artifact, 'fresh build') if @built_artifact
  end
  def update_code_signing_settings(**options) = @calls << [:update_code_signing_settings,options]
  def google_play_track_version_codes(**) = @calls.any? { |entry| entry.first == :upload_to_play_store } ? [1,2,7] : [1,2]
  def upload_to_play_store(**options) = @calls << [:upload_to_play_store,options]
  def upload_to_testflight(**options) = @calls << [:upload_to_testflight,options]
  def get_ipa_info_plist_value(ipa:, key:)
    return (@ipa_id || 'sh.bilal.shellbell') if key == 'CFBundleIdentifier'
    return ReleaseState.marketing_version if key == 'CFBundleShortVersionString'
    '7'
  end
end

module Spaceship
  module ConnectAPI
    class << self
      attr_accessor :token, :app
    end
    class Token
      def self.from(filepath:) = :test_token
    end
    class App
      def self.find(identifier) = ConnectAPI.app
    end
  end
end
class InternalGroup
  attr_accessor :is_internal_group
  attr_reader :builds
  def initialize
    @is_internal_group=true; @builds=[]
  end
  def name = 'Internal'
  def fetch_builds = @builds
end
class ProcessedBuild
  attr_accessor :missing_export_compliance, :internally_testable, :internal_build_state, :uses_non_exempt_encryption
  attr_reader :updates
  def initialize
    @missing_export_compliance = false
    @internally_testable = true
    @internal_build_state = 'READY_FOR_BETA_TESTING'
    @uses_non_exempt_encryption = nil
    @updates = []
  end
  def id = 'new-build'
  def missing_export_compliance? = @missing_export_compliance
  def ready_for_internal_testing? = @internally_testable
  def build_beta_detail = Struct.new(:internal_build_state).new(@internal_build_state)
  def update(attributes:)
    @updates << attributes
    @uses_non_exempt_encryption = attributes.fetch(:usesNonExemptEncryption)
  end
  def add_beta_groups(beta_groups:)
    beta_groups.each { |group| group.builds << self }
  end
end
class StoreApp
  attr_accessor :id
  attr_reader :group, :processed_build
  def initialize
    @id='123456'; @group=InternalGroup.new; @queries=0; @processed_build=ProcessedBuild.new
  end
  def get_beta_groups = [@group]
  def get_builds(filter:, includes: nil)
    @queries+=1
    if @queries > 1
      raise 'Build testing state must be explicitly requested' unless includes == 'buildBetaDetail'
      return [@processed_build]
    end
    []
  end
end
module Spaceship::ConnectAPI
  class Build
    def self.get(build_id:)
      build = Spaceship::ConnectAPI.app.processed_build
      raise 'Unexpected build refresh' unless build.id == build_id
      build
    end
  end
end

class LanesTest < Minitest::Test
  def setup
    @previous = ENV.to_h
    ENV.keys.grep(/^SHELLBELL_/).each { |key| ENV.delete(key) }
    ENV['SHELLBELL_BUILD_NUMBER']='7'
    @harness = LaneHarness.new
    Spaceship::ConnectAPI.app=StoreApp.new
    file = File.expand_path('../Fastfile', __dir__)
    assert File.file?(file), 'local Fastlane lanes must exist'
    @harness.instance_eval(File.read(file),file)
  end
  def teardown
    ENV.replace(@previous)
  end
  def test_android_build_never_uploads
    @harness.run(:android,:build)
    assert_equal [:sh], @harness.calls.map(&:first)
    assert_includes @harness.calls.first[1], 'android'
  end
  def test_internal_upload_requires_explicit_confirmation
    assert_raises(ArgumentError) { @harness.run(:android,:internal) }
    assert_empty @harness.calls
  end
  def test_android_upload_is_internal_and_does_not_replace_metadata
    Dir.mktmpdir('lane-') do |dir|
      {'SHELLBELL_ARTIFACT'=>'app.aab','SHELLBELL_PLAY_CREDENTIALS_PATH'=>'private.json',
       'SHELLBELL_BUNDLETOOL_JAR'=>'bundletool.jar'}.each do |key,name|
        ENV[key]=File.join(dir,name); File.write(ENV[key],'fixture')
      end
      ENV['SHELLBELL_CONFIRM_UPLOAD']='internal'
      @harness.run(:android,:internal)
      uploads = @harness.calls.select { |entry| entry.first == :upload_to_play_store }
      assert_equal 1, uploads.length
      options=uploads.first[1]
      assert_equal 'internal', options[:track]
      assert_equal 'sh.bilal.shellbell', options[:package_name]
      assert_equal true, options[:skip_upload_metadata]
      assert_equal true, options[:skip_upload_images]
      assert_equal true, options[:skip_upload_screenshots]
      refute options.key?(:track_promote_to)
    end
  end
  def test_ios_prebuild_runs_ruby_tools_outside_the_fastlane_bundle
    ENV['SHELLBELL_APPLE_TEAM_ID']='ABCDEFGHIJ'
    ENV['SHELLBELL_IOS_PROFILE']='HostProfile'
    ENV['SHELLBELL_IOS_NOTIFICATION_PROFILE']='ExtensionProfile'
    Dir.mktmpdir('bundled-native-build-') do |dir|
      gemfile=File.join(dir,'Gemfile')
      File.write(gemfile,"gem 'missing_native_build_fixture', '= 0.0.0'\n")
      ENV['BUNDLE_GEMFILE']=gemfile
      ENV['RUBYOPT']='-rbundler/setup'
      @harness.node_build_probe=lambda do
        output,status=Open3.capture2e(RbConfig.ruby,'-e', <<~RUBY)
          abort 'Bundler configuration leaked into native tools' if ENV['BUNDLE_GEMFILE'] || ENV.fetch('RUBYOPT','').include?('bundler/setup')
          abort 'Release configuration was lost' unless ENV['SHELLBELL_APPLE_TEAM_ID']=='ABCDEFGHIJ' && ENV['SHELLBELL_BUILD_NUMBER']=='7'
          puts 'isolated'
        RUBY
        assert status.success?, output
        assert_equal "isolated\n", output
      end
      @harness.run(:ios,:build)
      assert_equal gemfile, ENV['BUNDLE_GEMFILE']
      assert_equal '-rbundler/setup', ENV['RUBYOPT']
    end
  end

  def with_ios_upload
    Dir.mktmpdir('ios-lane-') do |dir|
      {'SHELLBELL_ARTIFACT'=>'app.ipa','SHELLBELL_ASC_API_KEY_PATH'=>'key.json'}.each do |key,name|
        ENV[key]=File.join(dir,name); File.write(ENV[key],'fixture')
      end
      ENV['SHELLBELL_CONFIRM_UPLOAD']='internal'
      ENV['SHELLBELL_ASC_APP_ID']='123456'
      ENV['SHELLBELL_TESTFLIGHT_GROUP']='Internal'
      yield
    end
  end
  def test_ios_upload_assigns_only_the_existing_internal_group
    with_ios_upload do
      @harness.run(:ios,:internal)
      options=@harness.calls.find { |call| call.first==:upload_to_testflight }[1]
      assert_equal false, options[:distribute_external]
      assert_equal true, options[:skip_submission]
      assert_equal false, options[:skip_waiting_for_build_processing]
      refute options.key?(:uses_non_exempt_encryption), 'An unset declaration must not imply an exemption'
      assert_empty Spaceship::ConnectAPI.app.processed_build.updates
      assert_equal ['new-build'], Spaceship::ConnectAPI.app.group.fetch_builds.map(&:id)
    end
  end
  def test_ios_refuses_wrong_store_record_or_external_group_before_upload
    with_ios_upload do
      Spaceship::ConnectAPI.app.id='654321'
      assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      Spaceship::ConnectAPI.app.id='123456'
      Spaceship::ConnectAPI.app.group.is_internal_group=false
      assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      assert_empty @harness.calls
    end
  end
  def test_ios_passes_an_explicit_documentation_exemption_as_boolean_false
    with_ios_upload do
      ENV['SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION'] = 'false'
      @harness.run(:ios,:internal)
      assert_equal [{usesNonExemptEncryption: false}], Spaceship::ConnectAPI.app.processed_build.updates
      assert_equal false, Spaceship::ConnectAPI.app.processed_build.uses_non_exempt_encryption
    end
  end
  def test_ios_passes_an_explicit_non_exempt_declaration_as_boolean_true
    with_ios_upload do
      ENV['SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION'] = 'true'
      @harness.run(:ios,:internal)
      assert_equal [{usesNonExemptEncryption: true}], Spaceship::ConnectAPI.app.processed_build.updates
      assert_equal true, Spaceship::ConnectAPI.app.processed_build.uses_non_exempt_encryption
    end
  end
  def test_ios_rejects_an_invalid_encryption_declaration_before_upload
    with_ios_upload do
      ENV['SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION'] = 'no'
      assert_raises(ArgumentError) { @harness.run(:ios,:internal) }
      assert_empty @harness.calls
    end
  end
  def test_ios_preserves_an_existing_encryption_declaration_that_differs
    with_ios_upload do
      ENV['SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION'] = 'false'
      build = Spaceship::ConnectAPI.app.processed_build
      build.uses_non_exempt_encryption = true
      error = assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      assert_match(/existing encryption declaration differs/, error.message)
      assert_equal true, build.uses_non_exempt_encryption
      assert_empty build.updates
      assert_empty Spaceship::ConnectAPI.app.group.fetch_builds
    end
  end
  def test_ios_keeps_an_uploaded_build_unassigned_when_export_compliance_is_missing
    with_ios_upload do
      Spaceship::ConnectAPI.app.processed_build.missing_export_compliance = true
      error = assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      assert_match(/complete export compliance/, error.message)
      assert_match(/Do not re-upload/, error.message)
      assert_equal [:upload_to_testflight], @harness.calls.map(&:first)
      assert_empty Spaceship::ConnectAPI.app.group.fetch_builds
    end
  end
  def test_ios_keeps_an_uploaded_build_unassigned_when_it_is_not_internally_testable
    with_ios_upload do
      Spaceship::ConnectAPI.app.processed_build.internally_testable = false
      error = assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      assert_match(/not internally testable/, error.message)
      assert_match(/Do not re-upload/, error.message)
      assert_equal [:upload_to_testflight], @harness.calls.map(&:first)
      assert_empty Spaceship::ConnectAPI.app.group.fetch_builds
    end
  end
  def test_ios_can_assign_a_build_that_is_already_in_internal_testing
    with_ios_upload do
      Spaceship::ConnectAPI.app.processed_build.internally_testable = false
      Spaceship::ConnectAPI.app.processed_build.internal_build_state = 'IN_BETA_TESTING'
      @harness.run(:ios,:internal)
      assert_equal ['new-build'], Spaceship::ConnectAPI.app.group.fetch_builds.map(&:id)
    end
  end
  def test_ios_rejects_an_artifact_for_another_app
    with_ios_upload do
      @harness.ipa_id='another.app'
      assert_raises(RuntimeError) { @harness.run(:ios,:internal) }
      assert_empty @harness.calls
    end
  end
  def test_ios_build_does_not_use_upload_credentials
    ENV['SHELLBELL_APPLE_TEAM_ID']='ABCDEFGHIJ'
    ENV['SHELLBELL_IOS_PROFILE']='HostProfile'
    ENV['SHELLBELL_IOS_NOTIFICATION_PROFILE']='ExtensionProfile'
    @harness.run(:ios,:build)
    assert_equal [:sh,:update_code_signing_settings,:update_code_signing_settings,:build_app], @harness.calls.map(&:first)
    assert_equal ['sh.bilal.shellbell','sh.bilal.shellbell.notifications'],
      @harness.calls.last[1][:export_options][:provisioningProfiles].keys
  end

  def with_build_upload(platform)
    Dir.mktmpdir('build-upload-') do |dir|
      extension = platform == :android ? '.aab' : '.ipa'
      ENV['SHELLBELL_CONFIRM_UPLOAD'] = 'internal'
      ENV['SHELLBELL_ARTIFACT'] = File.join(dir, "unrelated#{extension}")
      File.write(ENV['SHELLBELL_ARTIFACT'], 'unrelated artifact')
      credentials = platform == :android ? 'SHELLBELL_PLAY_CREDENTIALS_PATH' : 'SHELLBELL_ASC_API_KEY_PATH'
      ENV[credentials] = File.join(dir, 'private.json')
      File.write(ENV[credentials], '{}')
      ENV['SHELLBELL_BUNDLETOOL_JAR'] = File.join(dir, 'bundletool.jar')
      File.write(ENV['SHELLBELL_BUNDLETOOL_JAR'], 'fixture')
      ENV['SHELLBELL_ASC_APP_ID'] = '123456'
      ENV['SHELLBELL_TESTFLIGHT_GROUP'] = 'Internal'
      ENV['SHELLBELL_APPLE_TEAM_ID'] = 'ABCDEFGHIJ'
      ENV['SHELLBELL_IOS_PROFILE'] = 'HostProfile'
      ENV['SHELLBELL_IOS_NOTIFICATION_PROFILE'] = 'ExtensionProfile'
      generated = File.join(dir, "built#{extension}")
      File.write(generated, 'old build')
      @harness.built_artifact = generated
      ReleaseConfig.stub(:built_artifact, generated) { yield generated }
    end
  end


  def test_ci_lanes_allocate_before_building_without_an_initial_build_number
    [:android,:ios].each do |platform|
      @harness.calls.clear
      with_build_upload(platform) do |generated|
        ENV.delete('SHELLBELL_BUILD_NUMBER')
        ENV['SHELLBELL_RELEASE_SOURCE_SHA']='a'*40
        ENV['SHELLBELL_RELEASE_RECEIPT']=File.join(File.dirname(generated), 'receipt.json')
        ENV['SHELLBELL_ANDROID_SIGNING_CONFIG']=File.join(File.dirname(generated), 'signing.json')
        File.write(ENV['SHELLBELL_ANDROID_SIGNING_CONFIG'], JSON.generate({'key_alias'=>'test','store_password'=>'test','key_password'=>'test'}))
        allocate = ->(*) { assert_nil ENV['SHELLBELL_BUILD_NUMBER']; assert_empty @harness.calls; 7 }
        ReleaseState.stub(:android_client, Object.new) do
          ReleaseState.stub(platform == :android ? :next_android : :next_ios, allocate) do
            @harness.run(platform,:ci_internal)
          end
        end
        receipt=JSON.parse(File.read(ENV.fetch('SHELLBELL_RELEASE_RECEIPT')))
        assert_equal 7, receipt.fetch('buildNumber')
        assert_equal platform.to_s, receipt.fetch('platform')
        assert_equal 'a'*40, receipt.fetch('sourceCommit')
        assert_equal Digest::SHA256.file(generated).hexdigest, receipt.fetch('artifactSha256')
        assert_equal true, receipt.fetch('storeAssignmentVerified')
      end
    end
  end

  def test_ios_creates_the_source_map_parent_before_archiving
    with_build_upload(:ios) do |generated|
      source_map=File.join(File.dirname(generated), 'new-diagnostics', 'main.jsbundle.map')
      ENV['SOURCEMAP_FILE']=source_map
      refute File.directory?(File.dirname(source_map))
      @harness.node_build_probe=-> { assert File.directory?(File.dirname(source_map)) }
      @harness.run(:ios,:build)
      assert File.directory?(File.dirname(source_map))
      assert @harness.calls.any? { |entry| entry.first == :build_app && entry[1][:buildlog_path].end_with?('/output/ios/build-logs') }
    end
  end

  def test_ci_store_read_failure_never_builds_or_uploads
    [:android,:ios].each do |platform|
      @harness.calls.clear
      with_build_upload(platform) do |generated|
        ENV.delete('SHELLBELL_BUILD_NUMBER')
        ENV['SHELLBELL_ANDROID_SIGNING_CONFIG']=File.join(File.dirname(generated), 'signing.json')
        File.write(ENV['SHELLBELL_ANDROID_SIGNING_CONFIG'], JSON.generate({'key_alias'=>'test','store_password'=>'test','key_password'=>'test'}))
        ReleaseState.stub(:android_client, Object.new) do
          ReleaseState.stub(platform == :android ? :next_android : :next_ios, ->(*) { raise 'Store unavailable' }) do
            assert_raises(RuntimeError) { @harness.run(platform,:ci_internal) }
          end
        end
        assert_empty @harness.calls
        assert_equal 'old build', File.read(generated)
      end
    end
  end

  def test_build_internal_uploads_the_fresh_artifact_and_preserves_explicit_artifact_setting
    [:android, :ios].each do |platform|
      @harness.calls.clear
      with_build_upload(platform) do |generated|
        original = ENV.fetch('SHELLBELL_ARTIFACT')
        @harness.run(platform, :build_internal)
        uploads = @harness.calls.select { |entry| [:upload_to_play_store, :upload_to_testflight].include?(entry.first) }
        assert_equal 1, uploads.length
        options = uploads.first[1]
        assert_equal generated, options[platform == :android ? :aab : :ipa]
        assert_equal 'fresh build', File.read(generated)
        assert_equal original, ENV.fetch('SHELLBELL_ARTIFACT')
        assert_equal 'unrelated artifact', File.read(original)
        if platform == :android
          assert_equal 'internal', options[:track]
          refute options.key?(:track_promote_to)
        else
          assert_equal false, options[:distribute_external]
          assert_equal ['new-build'], Spaceship::ConnectAPI.app.group.fetch_builds.map(&:id)
        end
      end
    end
  end

  def test_failed_build_never_uploads_an_old_artifact
    [:android, :ios].each do |platform|
      @harness.calls.clear
      with_build_upload(platform) do |generated|
        @harness.build_error = RuntimeError.new('build failed')
        assert_raises(RuntimeError) { @harness.run(platform, :build_internal) }
        refute File.exist?(generated)
        assert_empty @harness.calls.select { |entry| [:upload_to_play_store, :upload_to_testflight].include?(entry.first) }
      end
    end
  end

  def test_build_internal_validates_destination_before_building_or_removing_previous_output
    [:android, :ios].each do |platform|
      @harness.calls.clear
      with_build_upload(platform) do |generated|
        ENV.delete('SHELLBELL_CONFIRM_UPLOAD')
        assert_raises(ArgumentError) { @harness.run(platform, :build_internal) }
        assert_empty @harness.calls
        assert_equal 'old build', File.read(generated)
        ENV['SHELLBELL_CONFIRM_UPLOAD'] = 'internal'
        ENV.delete(platform == :android ? 'SHELLBELL_PLAY_CREDENTIALS_PATH' : 'SHELLBELL_ASC_API_KEY_PATH')
        assert_raises(ArgumentError) { @harness.run(platform, :build_internal) }
        assert_empty @harness.calls
        assert_equal 'old build', File.read(generated)
      end
    end
  end
end
