# Подсветка кода в YFM Preview

## TypeScript

```typescript
// Комментарий
interface Greeting {
    message: string;
}
const greeting: Greeting = { message: "Привет!" };
console.log(greeting.message);
```

## JSON

```json
{"enabled": true, "delay": 500, "languages": ["ru", "en"]}
```

## Bash

```bash
# Сборка плагина
pnpm run build
echo "Готово"
```

## Python

```python
def greet(name: str):
    return f"Привет, {name}!"
```

## Diff

```diff
-const delay = 100;
+const delay = 500;
```

## Без языка

```
<script>Этот текст остаётся кодом</script>
```

## Неизвестный язык

```unknown-language
<example>Текст без подсветки</example>
```
