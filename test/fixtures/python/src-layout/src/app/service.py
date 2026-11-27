from .models import Model
from .types import Payload


class Service:
    def load(self) -> Payload:
        return Model()
