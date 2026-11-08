"""Every model call goes to Vultr Serverless Inference: the client refuses any other endpoint, whatever the settings say."""
import pytest

from control import llm, settings


@pytest.mark.parametrize("base", [
    "https://api.openai.com/v1",
    "https://api.anthropic.com/v1",
    "http://127.0.0.1:11434/v1",
    "https://api.vultrinference.com.evil.example/v1",
    "https://evil.example/api.vultrinference.com/v1",
])
def test_a_non_vultr_endpoint_is_refused_before_any_call(monkeypatch, base):
    monkeypatch.setattr(settings, "INFERENCE_BASE", base)
    monkeypatch.setattr(settings, "INFERENCE_KEY", "k")
    with pytest.raises(llm.LLMError, match="non-Vultr"):
        llm._client()


def test_the_vultr_endpoint_passes_the_check(monkeypatch):
    monkeypatch.setattr(settings, "INFERENCE_BASE", "https://api.vultrinference.com/v1")
    monkeypatch.setattr(settings, "INFERENCE_KEY", "k")
    built = {}
    monkeypatch.setattr(llm, "OpenAI", lambda **kw: built.update(kw) or "client")
    assert llm._client() == "client"
    assert built["base_url"] == "https://api.vultrinference.com/v1"


def test_the_configured_endpoint_is_vultr():
    assert llm.is_vultr_base(settings.INFERENCE_BASE)


def test_a_chat_with_a_non_vultr_endpoint_never_reaches_a_client(monkeypatch):
    monkeypatch.setattr(settings, "INFERENCE_BASE", "https://api.openai.com/v1")
    with pytest.raises(llm.LLMError):
        llm.chat("explainer", "any-model", [{"role": "user", "content": "hi"}])
