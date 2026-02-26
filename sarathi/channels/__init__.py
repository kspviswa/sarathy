"""Chat channels module with plugin architecture."""

from sarathi.channels.base import BaseChannel
from sarathi.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
