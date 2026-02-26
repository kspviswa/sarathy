"""Chat channels module with plugin architecture."""

from sarathy.channels.base import BaseChannel
from sarathy.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
