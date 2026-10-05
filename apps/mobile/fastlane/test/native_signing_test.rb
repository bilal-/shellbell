require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require 'fastlane'
require 'fastlane/actions/update_code_signing_settings'
require 'xcodeproj'

# Run after Expo iOS prebuild. Exercise actual generated targets and Fastlane's
# signing action, but never invoke Xcode, signing services, or store APIs.
class NativeSigningTest < Minitest::Test
  class Harness
    attr_accessor :project_path
    def default_platform(*) = nil
    def opt_out_usage = nil
    def desc(*) = nil
    def platform(name, &block)
      @platform = name
      instance_eval(&block)
    end
    def lane(name, &block)
      @build = block if @platform == :ios && name == :build
    end
    def sh(*) = nil
    def update_code_signing_settings(**options)
      options[:path] = project_path
      Fastlane::Actions::UpdateCodeSigningSettingsAction.run(options)
    end
    def build_app(**)
      project = Xcodeproj::Project.open(project_path)
      yield_project = @inspect
      yield_project.call(project)
    end
    def run(&block)
      @inspect = block
      instance_exec(&@build)
    end
  end

  def test_release_profiles_are_applied_to_generated_targets_before_archive
    original = ENV.to_h
    ENV['SHELLBELL_BUILD_NUMBER'] = '7'
    ENV['SHELLBELL_APPLE_TEAM_ID'] = 'ABCDEFGHIJ'
    ENV['SHELLBELL_IOS_PROFILE'] = 'HostProfile'
    ENV['SHELLBELL_IOS_NOTIFICATION_PROFILE'] = 'ExtensionProfile'
    source = File.expand_path('../../ios/Shellbell.xcodeproj', __dir__)
    assert File.directory?(source), 'Run Expo iOS prebuild before native signing verification'
    Dir.mktmpdir('shellbell-signing-') do |dir|
      FileUtils.cp_r(source, dir)
      harness = Harness.new
      harness.project_path = File.join(dir, 'Shellbell.xcodeproj')
      before = Xcodeproj::Project.open(harness.project_path)
      # Normalize Expo's scalar/list serialization before comparing semantic settings.
      before.save
      before = Xcodeproj::Project.open(harness.project_path)
      debug = before.targets.to_h { |target| [target.name, target.build_configurations.find { |c| c.name == 'Debug' }.build_settings.dup] }
      file = File.expand_path('../Fastfile', __dir__)
      harness.instance_eval(File.read(file), file)
      harness.run do |project|
        {'Shellbell'=>'HostProfile', 'ShellbellNotifications'=>'ExtensionProfile'}.each do |name, profile|
          target = project.targets.find { |item| item.name == name }
          refute_nil target
          release = target.build_configurations.find { |item| item.name == 'Release' }.build_settings
          assert_equal 'Manual', release['CODE_SIGN_STYLE']
          assert_equal 'ABCDEFGHIJ', release['DEVELOPMENT_TEAM']
          assert_equal 'Apple Distribution', release['CODE_SIGN_IDENTITY']
          assert_equal profile, release['PROVISIONING_PROFILE_SPECIFIER']
          assert_equal debug.fetch(name), target.build_configurations.find { |c| c.name == 'Debug' }.build_settings
        end
      end
    end
  ensure
    ENV.replace(original)
  end
end
