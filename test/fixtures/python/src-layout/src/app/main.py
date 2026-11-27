from app.service import Service
from .models import Model


def handler():
    return Service(), Model()
