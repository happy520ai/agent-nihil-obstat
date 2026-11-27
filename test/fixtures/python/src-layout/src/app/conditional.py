try:
    from .fast import fast_value
except ImportError:
    from .slow import slow_value
