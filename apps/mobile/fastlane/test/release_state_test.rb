require 'minitest/autorun'
require 'ostruct'
require_relative '../release_config'
require_relative '../release_state'

class ReleaseStateTest < Minitest::Test
  class Play
    attr_reader :deleted
    attr_accessor :fail_read
    def insert_edit(id) = OpenStruct.new(id: 'read-only-edit')
    def list_edit_bundles(*)
      raise 'provider failure' if fail_read
      OpenStruct.new(bundles: [OpenStruct.new(version_code: 7)])
    end
    def list_edit_apks(*) = OpenStruct.new(apks: [OpenStruct.new(version_code: 11)])
    def list_edit_tracks(*)
      OpenStruct.new(tracks: [OpenStruct.new(releases: [OpenStruct.new(version_codes: ['19'])])])
    end
    def delete_edit(id, edit) = @deleted = [id, edit]
  end

  def test_counter_uses_all_accepted_numbers_and_rejects_invalid_history
    assert_equal 1, ReleaseState.next_number([])
    assert_equal 20, ReleaseState.next_number(['4', 19, '11'])
    [nil, '0', '-1', '1.2', '01', '2100000001'].each { |number| assert_raises(RuntimeError) { ReleaseState.next_number([number]) } }
    assert_raises(RuntimeError) { ReleaseState.next_number([2_100_000_000]) }
  end

  def test_android_checks_bundles_apks_and_all_tracks_without_committing_an_edit
    client = Play.new
    assert_equal 20, ReleaseState.next_android(client, 'sh.bilal.shellbell')
    assert_equal ['sh.bilal.shellbell', 'read-only-edit'], client.deleted
  end

  def test_android_read_failure_still_removes_the_temporary_edit
    client = Play.new
    client.fail_read = true
    assert_raises(RuntimeError) { ReleaseState.next_android(client, 'sh.bilal.shellbell') }
    assert_equal ['sh.bilal.shellbell', 'read-only-edit'], client.deleted
  end

  def test_ios_counts_expired_and_processing_builds_too
    app = Object.new
    def app.get_builds = [OpenStruct.new(version: '2', expired: true), OpenStruct.new(version: '17', processing_state: 'PROCESSING')]
    assert_equal 18, ReleaseState.next_ios(app)
  end
end
