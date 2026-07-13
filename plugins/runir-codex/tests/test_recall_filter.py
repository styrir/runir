import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hooks"))

from recall_filter import (
    is_empty,
    is_punctuation_only,
    is_slash_command,
    is_ack,
    looks_like_shell_command,
    should_skip_client_recall,
)


class TestIsEmpty:
    def test_empty_string(self):
        assert is_empty("") is True

    def test_whitespace_only(self):
        assert is_empty("   ") is True

    def test_tab_newline(self):
        assert is_empty("\t\n") is True

    def test_non_empty(self):
        assert is_empty("hello") is False


class TestIsPunctuationOnly:
    def test_dots(self):
        assert is_punctuation_only("...") is True

    def test_mixed_punctuation(self):
        assert is_punctuation_only("!?.,;") is True

    def test_empty_string(self):
        assert is_punctuation_only("") is False

    def test_has_letters(self):
        assert is_punctuation_only("ok!") is False

    def test_whitespace_only(self):
        assert is_punctuation_only("   ") is False


class TestIsSlashCommand:
    def test_help(self):
        assert is_slash_command("/help") is True

    def test_leading_space_slash(self):
        assert is_slash_command("  /help") is True

    def test_not_slash(self):
        assert is_slash_command("help") is False

    def test_slash_in_middle(self):
        assert is_slash_command("use /help to get help") is False


class TestIsAck:
    def test_ok(self):
        assert is_ack("ok") is True

    def test_ok_with_punctuation(self):
        assert is_ack("ok.") is True

    def test_ok_exclamation(self):
        assert is_ack("OK!") is True

    def test_sounds_good(self):
        assert is_ack("sounds good") is True

    def test_thanks(self):
        assert is_ack("thanks") is True

    def test_thank_you(self):
        assert is_ack("thank you") is True

    def test_continue_is_not_ack(self):
        assert is_ack("continue") is False

    def test_go_ahead_is_not_ack(self):
        assert is_ack("go ahead") is False

    def test_sentence_is_not_ack(self):
        assert is_ack("ok let's do that") is False


class TestLooksLikeShellCommand:
    def test_git_status(self):
        assert looks_like_shell_command("git status") is True

    def test_ls_alone(self):
        assert looks_like_shell_command("ls") is True

    def test_npm_install(self):
        assert looks_like_shell_command("npm install") is True

    def test_git_version_flag(self):
        assert looks_like_shell_command("git --version") is True

    def test_cat_file_path(self):
        assert looks_like_shell_command("cat src/index.ts") is True

    def test_docker_exec(self):
        assert looks_like_shell_command("docker exec") is True

    def test_piped_command(self):
        assert looks_like_shell_command("git log | grep fix") is True

    def test_git_natural_language(self):
        assert looks_like_shell_command("git is still failing in CI") is False

    def test_npm_natural_language(self):
        assert looks_like_shell_command("npm keeps throwing errors in prod") is False

    def test_non_shell_word(self):
        assert looks_like_shell_command("explain this to me") is False

    def test_empty(self):
        assert looks_like_shell_command("") is False


class TestShouldSkipClientRecall:
    def test_skips_empty(self):
        assert should_skip_client_recall("") is True

    def test_skips_ack(self):
        assert should_skip_client_recall("ok") is True

    def test_skips_slash(self):
        assert should_skip_client_recall("/help") is True

    def test_skips_shell(self):
        assert should_skip_client_recall("git status") is True

    def test_skips_punctuation(self):
        assert should_skip_client_recall("...") is True

    def test_passes_continue(self):
        assert should_skip_client_recall("continue") is False

    def test_passes_question(self):
        assert should_skip_client_recall("why is this test failing?") is False

    def test_passes_resume(self):
        assert should_skip_client_recall("resume from where we left off") is False

    def test_passes_natural_git(self):
        assert should_skip_client_recall("git is still failing in CI") is False

    def test_passes_real_prompt(self):
        assert should_skip_client_recall("refactor the auth module to use JWT") is False
