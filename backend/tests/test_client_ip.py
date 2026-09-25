"""Tests for main.resolve_client_ip (hardening pass M3).

Reverse-proxy deployments make request.client.host the same value (the
proxy's own address) for every request, which silently defeats the
per-IP rate limiters (route analysis, staff auth). resolve_client_ip only
trusts X-Forwarded-For when the direct TCP peer is explicitly listed in
TRUSTED_PROXY_IPS, so an untrusted client can't spoof an arbitrary IP by
just sending the header itself.
"""

import pathlib
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


def make_request(direct_ip, headers=None):
    client = SimpleNamespace(host=direct_ip) if direct_ip is not None else None
    return SimpleNamespace(client=client, headers=headers or {})


class TestResolveClientIp:
    def test_no_trusted_proxies_configured_uses_direct_ip(self, monkeypatch):
        monkeypatch.delenv("TRUSTED_PROXY_IPS", raising=False)
        request = make_request("203.0.113.5", {"X-Forwarded-For": "198.51.100.9"})

        assert main.resolve_client_ip(request) == "203.0.113.5"

    def test_untrusted_direct_ip_ignores_forwarded_header(self, monkeypatch):
        monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
        request = make_request("203.0.113.5", {"X-Forwarded-For": "198.51.100.9"})

        assert main.resolve_client_ip(request) == "203.0.113.5"

    def test_trusted_proxy_uses_forwarded_for_rightmost_value(self, monkeypatch):
        # PMレビューm-4: 単一のtrusted proxyを前提とする構成では、そのproxy
        # 自身が(既存のX-Forwarded-Forの末尾に)書き足した値だけが安全に
        # 信頼できる。ここでは、そのproxyが直接受けた接続元(実クライアント)
        # が198.51.100.9であるケースを表す。
        monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1,10.0.0.2")
        request = make_request(
            "10.0.0.1", {"X-Forwarded-For": "198.51.100.9"}
        )

        assert main.resolve_client_ip(request) == "198.51.100.9"

    def test_trusted_proxy_ignores_client_supplied_prefix_and_uses_its_own_appended_value(
        self, monkeypatch
    ):
        # PMレビューm-4で修正した箇所: もし最左端を信頼すると、攻撃者が直接
        # proxyへ`X-Forwarded-For: 1.2.3.4`を付けて送り、proxyがその末尾に
        # 自分の見た実際の接続元(198.51.100.9)を追記した場合でも、偽装された
        # 1.2.3.4の方を信頼してなりすましを許してしまう。最右端(=trusted
        # proxy自身が書き足した値)を使うことで、この偽装を防ぐ。
        monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
        request = make_request(
            "10.0.0.1", {"X-Forwarded-For": "1.2.3.4, 198.51.100.9"}
        )

        assert main.resolve_client_ip(request) == "198.51.100.9"

    def test_trusted_proxy_without_forwarded_header_falls_back_to_direct_ip(
        self, monkeypatch
    ):
        monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
        request = make_request("10.0.0.1", {})

        assert main.resolve_client_ip(request) == "10.0.0.1"

    def test_no_client_info_returns_unknown(self, monkeypatch):
        monkeypatch.delenv("TRUSTED_PROXY_IPS", raising=False)
        request = make_request(None)

        assert main.resolve_client_ip(request) == "unknown"

    def test_spoofed_forwarded_for_without_trusted_direct_ip_is_ignored(
        self, monkeypatch
    ):
        # An attacker directly connecting (not via a trusted proxy) cannot
        # claim an arbitrary IP just by sending the header themselves.
        monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
        request = make_request("198.51.100.200", {"X-Forwarded-For": "1.2.3.4"})

        assert main.resolve_client_ip(request) == "198.51.100.200"
