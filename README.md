# tv-debug-mcp

MCP-сервер для полуручного прогона QA-кейсов на **реальных Smart TV** (Tizen / webOS) и на **локальном Chrome** — через Chrome DevTools Protocol. Агент управляет приложением: навигация пультом, лонгтап с точными таймингами, переходы по меню, чтение консоли и состояния плеера. Человек подтверждает то, что можно проверить только глазами.

Закрывает боль ручного тестирования сложных кейсов (лонгтап, перемещения, меню) на всём парке устройств, включая старые.

## Быстрый старт

```bash
git clone https://github.com/Ediand11/tv-debug-mcp.git
cd tv-debug-mcp
npm install                                    # за корп-прокси: env -u HTTP_PROXY -u HTTPS_PROXY npm install
cp devices.example.json devices.json           # devices.json в .gitignore — ваш парк остаётся локальным
npm run check:browser                          # зелёный прогон без ТВ: свой Chrome + встроенная фикстура
```

Дальше — зарегистрировать сервер в Claude Code:

```bash
claude mcp add tv-debug --scope user -- node "$PWD/src/server.js"
```

Тулы появятся как `mcp__tv-debug__*`. Проверить, что MCP видит парк: попросить агента вызвать `tv_devices`.

Чтобы гонять **своё** приложение, а не фикстуру:

1. в `devices.json` описать устройство (`platform`, `appId`, `host` для ТВ или `url` для браузера) — поля и их проверки описаны в [«Парк устройств»](#парк-устройств);
2. завести `apps/<id>.json` с селекторами приложения и сослаться на него полем `"app"` — см. [«App-профиль»](#app-профиль), готовый пример лежит в `apps/fixture.json`;
3. для ТВ — Developer Mode на устройстве и подключённый `sdb` / `ares`.

Node ≥ 18. Зависимости: `@modelcontextprotocol/sdk`, `ws`, `source-map-js` (чистый JS-порт `source-map` 0.6, без wasm — важно для офлайн-запуска).

## Зачем не Appium / не playwriter

- **Appium TV-драйверы** тянут chromedriver, который мёртв на Tizen с Chrome ≤ 57 и держится на хаке подмены UA на webOS 3. Тяжёлая инфра, два разных драйвера.
- **playwriter / Playwright connectOverCDP** требует свежий Chromium — не заведётся на webOS 3/4 (Chrome 38/53).
- **Этот MCP** говорит с инспектором по «голому» CDP. Один кодовый путь от Chrome 38 до 120+, ноль зависимостей на устройстве. Тот же набор тулов работает и против браузера на ноуте.

## Инструменты (16)

| Тул | Что делает |
|---|---|
| `tv_devices` | Парк из `devices.json`: доступность и **реальные** capabilities каждого устройства |
| `tv_install` | Установка билда (`.wgt` / `.ipk`). `uninstallFirst:true` лечит «Author certificate not match» |
| `tv_launch` | Debug-запуск + attach по CDP. Режимы: свежий старт / `reload` / `relaunch` / `attach` |
| `tv_press` | Клавиша пульта. `durationMs` = лонгтап; `repeat`+`intervalMs` = серия. Возвращает фокус до/после и `inputMode` |
| `tv_state` | Структурный снимок: url, заголовок, видимые сцены, фокус (текст, класс, путь, индекс/всего), попапы, счётчики |
| `tv_wait_for` | Ожидание условия вместо `sleep`: `focusText` / `selector` / `selectorGone` / `scene` / `text` / `expression` / `videoAdvancing` |
| `tv_goto` | Жать направление, пока **сфокусированный** элемент не совпадёт с целью. Ограничен `maxSteps`, дедлайном и детектом «фокус встал» / «обернулись по кругу» |
| `tv_menu` | Войти в меню приложения и выбрать раздел по имени; без имени — открыть и вернуть список разделов |
| `tv_sequence` | Весь кейс одним вызовом: вердикт, время и результат по каждому шагу, под device-lock |
| `tv_screenshot` | PNG кадра. В браузере работает всегда; на Tizen деградирует с пометкой (secure/overlay plane) |
| `tv_console` | Консоль / исключения / упавшие запросы с момента launch. Все уровни, фильтр, счётчик отброшенного буфером |
| `tv_network` | Полный лог запросов с момента launch: url, метод, статус, тело POST. Чтение тела ответа по `requestId`, экспорт в `curl` и HAR 1.2, ассерт `expectRequest` шагом кейса |
| `tv_video_state` | Программный снимок `<video>`: тикает ли `currentTime` (два замера), readyState, размеры, MediaError |
| `tv_evaluate` | Произвольный JS в странице (escape hatch). На старых ТВ — только ES5 |
| `tv_profile` | Запись JS CPU-профиля (`start` → действия → `stop`): файл `.cpuprofile` для DevTools + топ функций и файлов по self time. `sourceMap` деминифицирует топ на прод-сборке. Плюс метрики `Performance.getMetrics` (heap, DOM-узлы, слушатели, layout) — снимок на `start` и на `stop`, в ответе diff; `action:"metrics"` снимает их отдельно, без записи профиля |
| `tv_heap` | Снапшот кучи на устройстве (`.heapsnapshot` для DevTools → Memory → Load) + сводка по конструкторам и счётчик detached-нод; `action:"diff"` сравнивает два файла, как Comparison view |

### tv_sequence — шаги

```json
{"launch": {"relaunch": true}}            // привести апп в известное состояние
{"press": "RIGHT", "repeat": 2}
{"longpress": "ENTER", "durationMs": 1600}
{"goto": {"direction": "DOWN", "text": "Library"}}
{"menu": "Settings"}
{"wait": {"scene": "player"}, "timeoutMs": 30000}
{"expect": {"selector": "[class*=context-menu]"}}
{"networkMark": true}                     // «считать запросы с этого места»
{"expectRequest": {"urlPattern": "track", "method": "POST", "bodyContains": "event_id"}}
{"eval": "document.title"}
{"sleep": 1500}
{"videoState": true, "expectAdvancing": true}
{"state": true}
{"profileStart": {"samplingIntervalUs": 1000}}
{"profileStop": {"path": "/tmp/scroll.cpuprofile", "sourceMap": "…/app.js.map"}}
{"metrics": true}                         // снимок Performance.getMetrics; {"collectGarbage": true} — с GC
```

`expect` — то же, что `wait`, но невыполнение валит шаг. `stopOnFail` по умолчанию `true`.

### tv_press — клавиши

`UP DOWN LEFT RIGHT ENTER BACK MENU INFO GUIDE SEARCH TOOLS CAPTION RED GREEN YELLOW BLUE PLAY PAUSE PLAY_PAUSE STOP REWIND FAST_FORWARD TRACK_NEXT TRACK_PREV RECORD CHANNEL_UP CHANNEL_DOWN PAGE_UP PAGE_DOWN VOLUME_UP VOLUME_DOWN VOLUME_MUTE EXIT DIGIT_0..9` (регистр не важен, можно сырой числовой keyCode). Коды взяты из платформенных input-слоёв Tizen (`TvKeyCode`) и webOS.

Лонгтап: `{"key":"ENTER","durationMs":1600}` — keydown, hold, keyup. Механика `LongPressService`: таймер стартует на keydown, keyup решает «клик или лонгтап». LG SSAP-пульт hold не выражает — поэтому синтетика, а не пульт.

### tv_network — лог сети, тела, curl/HAR и ассерты

`tv_console` показывает только **упавшие** запросы. Успешный запрос с неправильным телом невидим ни одному кейсу — а это целый класс регрессов: аналитика потеряла поле, из параметров API выпал один, стат-событие ушло дважды. `tv_network` — про это.

```
tv_network {"action": "list", "urlPattern": "track", "method": "POST"}   # action по умолчанию
tv_network {"action": "body", "requestId": "1234.5"}                     # тело ответа
tv_network {"action": "curl", "requestId": "1234.5"}                     # команда для терминала/тикета
tv_network {"action": "har",  "path": "/tmp/case.har", "urlPattern": "api."}
tv_network {"action": "mark"}                                            # сдвинуть окно ассертов
```

**`list`** — фильтры `urlPattern` (подстрока или `/regex/`), `method`, `status` (`"failed"` \| число \| `{"min":200,"max":299}`), `limit` (по умолчанию 50, новейшие первыми). Запись: `requestId`, `receivedAt`, `method`, `url` (обрезан до 500), `status`, `mimeType`, `resourceType`, `encodedDataLength`, `postData` (обрезан до 1000, флаг `postDataTruncated`), `failed` + `errorText`, `fromCache`, `redirectFrom` / `redirectedTo`, `inFlight`. Плюс `dropped` — сколько вытеснено из кольцевого буфера: ассерт по вытесненному запросу провалился бы молча, поэтому счётчик едет в каждом ответе.

**Ассерт в кейсе** — шаг `expectRequest` (и условие `{"request": {...}}` в `tv_wait_for`):

```json
{"networkMark": true}
{"menu": "Настройки"}
{"expectRequest": {"urlPattern": "track", "method": "POST",
                   "bodyContains": "event_id", "statusMax": 399, "timeoutMs": 8000}}
{"expectRequest": {"urlPattern": "stat.gif", "count": {"max": 1}, "timeoutMs": 3000}}
{"expectRequest": {"urlPattern": "ads", "absent": true, "timeoutMs": 3000}}
```

**Окно матчинга — начало своего шага**, как у остальных wait-условий. Но запрос — событие мгновенное, и тот, что улетел на предыдущем шаге, в окно уже не попадает: перед действием ставится `{"networkMark": true}`, и все `expectRequest` дальше считают от метки. Это главный практический момент тула.

`absent: true` и `count.max` **ждут весь `timeoutMs`** по определению: «ещё не пришло» и «не придёт» различимы только в конце окна, а дубль, прилетевший последним, — это ровно то, что ищут. Остальные формы возвращаются, как только матч есть.

Границы, каждая — свойство протокола, а не недоделка:

- **тела ответов не буферизуются на нашей стороне.** `getResponseBody` читает буфер движка, и после навигации или релонча тела там нет. Поэтому `action:"body"` отвечает на «почему каталог пустой» **сейчас** и честно падает потом; повторить историю нельзя — ловить надо ассертом в момент кейса;
- **POST-тела несут токены и куки.** В `list` тело режется до 1000 символов, целиком (до 64 КБ) хранится только ради curl/HAR и в отчёты не попадает. Гард на тело ответа — 256 КБ, на весь HAR — 50 МБ;
- **`receivedAt` — часы хоста**, момент приёма события, а не CDP `timestamp`: монотонные часы движков разных поколений несравнимы ни между собой, ни с хостом, а `wallTime` в Chrome 38 нет. Для QA-ассертов скью приёма несуществен;
- буфер сети — **1000 записей** (у консоли 500): апп стреляет сетью на порядок чаще;
- редирект переиспользует один `requestId`, поэтому каждый хоп пишется отдельной записью (`redirectFrom` / `redirectedTo`), а `action:"body"`/`"curl"` берут последний.

**`curl`**: `Cookie`, `Authorization` и `*token*`-заголовки заменяются на `REDACTED`, полный вариант — явным `"raw": true`. На движке без `requestWillBeSentExtraInfo` (Chromium <63 — весь парк старше tizen55) заголовки берутся из `requestWillBeSent.request.headers`, то есть это то, что знал **апп**, до того как движок навесил Cookie и UA; репро авторизованного запроса может не совпасть — приходит `warning`, а не тихое расхождение.

**`har`**: HAR 1.2 (creator `tv-debug-mcp`), открывается в DevTools → **Network → Import**, Charles, Insomnia — готовое вложение-пруф к багу. Заголовки пишутся **как есть**, без редактирования: HAR без Cookie ничего не воспроизводит. Отсюда правило — **в публичный тикет такой файл не класть**. Тела — best-effort и только «сейчас»: HAR в конце кейса будет с телами, снятый позже — метаданные, у таких entries `comment: "body evicted"`, счётчик `bodiesMissing` в ответе. Тайминги — из `response.timing`; чего движок не дал, то `-1` по спеке, а не выдуманное число.

**Платформы**: домен `Network` жив на всём парке (он и так включается на connect, cdp.js), `getResponseBody` — тоже. `requestWillBeSentExtraInfo`/`responseReceivedExtraInfo` (реальные wire-заголовки) — Chromium 63+, ниже curl предупреждает про куки.

### tv_profile — CPU-профиль и метрики

CPU-профиль — единственный перф-домен, который жив на всём парке: `Profiler.start/stop` есть и в Chromium 69 (tizen55), и в Chrome 38 (webos3) — в отличие от `Tracing`. Метрики `Performance.getMetrics` требуют Chromium 60+, поэтому они едут прицепом и никогда не ценой профиля (см. «Метрики» ниже).

```
tv_profile {"action": "start"}          # опц. samplingIntervalUs, по умолчанию 1000
tv_goto    {"direction": "DOWN", …}     # то, что меряем
tv_profile {"action": "stop", "sourceMap": "…/app.js.map", "topN": 20}
```

`stop` отдаёт:

- `path` — файл `.cpuprofile`. Открывается в Chrome DevTools → **Performance → Load profile** (кнопка ⤒). Сырой профиль в ответ тула не кладётся никогда — это сотни килобайт JSON;
- `summary.topFunctions` — self time и % по функциям (аггрегат по одинаковым фреймам; total time рекурсивной функции считается один раз, а не на каждом уровне);
- `summary.topFiles` — то же по файлам;
- `summary.special` — `(program)` / `(garbage collector)` / `(idle)` отдельно, в топ функций они не лезут;
- `metrics` — diff `Performance.getMetrics` за окно записи (или `null` на движке без домена);
- `warning` — если карта не прочиталась, если ни один топовый фрейм в ней не нашёлся, если формат легаси или если метрик на этом движке нет.

Self time = `hitCount × средний интервал семплинга`, где интервал выводится из самой записи (`длительность / число хитов`), а не из запрошенного `samplingIntervalUs` — старый движок вправе его проигнорировать.

**Прод-сборка без `sourceMap` — это топ вида `Xy`/`abc`.** Карту брать из **той же** сборки, что стоит на ТВ (`<каталог сорсмапов сборки>/app.js.map`); деминифицируются только топ-N фреймов, остальное DevTools разберёт сам по файлу.

Внутри `tv_sequence` — шагами `profileStart`/`profileStop`: сценарий держит операционный лок, отдельный `tv_profile` в него не влезет.

Форматы профиля различаются между поколениями движков и нормализуются оба: современный (`nodes[]`, 0-based строки, микросекунды) и легаси Chrome 38 (`head`-дерево, 1-based строки, секунды). Строки в саммари всегда 1-based, как показывает DevTools. Файл легаси-формата современный DevTools может не открыть — об этом приходит `warning`, саммари при этом валидное.

### tv_profile — метрики (heap, DOM, layout)

CPU-профиль показывает, где горит JS, и не видит ни память, ни layout. `Performance.getMetrics` — один дешёвый вызов, который отдаёт `JSHeapUsedSize`, `JSHeapTotalSize`, `Nodes`, `Documents`, `JSEventListeners`, `LayoutCount`, `RecalcStyleCount` и кумулятивные счётчики времени (`LayoutDuration`, `RecalcStyleDuration`, `ScriptDuration`, `TaskDuration`).

```
tv_profile {"action": "metrics"}                      # снимок здесь и сейчас
tv_profile {"action": "metrics", "collectGarbage": true}
```

`start` и `stop` снимают метрики сами, поэтому охота на утечку — это обычная запись:

```
tv_profile {"action": "start"}
tv_press   {"key": "DOWN", "repeat": 20}
tv_profile {"action": "stop", "collectGarbage": true}
```

`stop` вернёт

```json
"metrics": {
  "windowSec": 12.4,
  "collectedGarbage": true,
  "values": {
    "Nodes":            {"before": 1200,     "after": 1650,     "diff": 450},
    "JSEventListeners": {"before": 340,      "after": 352,      "diff": 12},
    "JSHeapUsedSize":   {"before": 20000000, "after": 24500000, "diff": 4500000},
    "LayoutDuration":   {"before": 0.1,      "after": 0.4,      "diff": 0.3}
  }
}
```

Читать так: `Nodes` вырос на 450 после того, как навигация вернулась туда же — сцена не разбирает свой DOM. `LayoutDuration` — секунды layout-времени именно за окно записи.

Детали:

- **Отдаётся весь список метрик, какой прислал движок**, без белых списков: набор в Chromium 69 и в свежем Chrome разный, а фильтр молча съел бы то, чего мы не ждали. Метрика, которую знает только один из двух снимков, остаётся в diff со стороной `null` — это тоже информация. Нечисловые значения проходят насквозь с `diff: null`;
- `windowSec` — из `Timestamp` (монотонные часы движка), не из часов хоста: раунд-трипы CDP в окно не входят;
- кумулятивные `*Duration` считаются с момента старта движка — смысл имеет только diff, не абсолют;
- **`collectGarbage` по умолчанию выключен.** Форсированный GC — это пауза: внутри записи она искажает и профиль, и поведение слабого ТВ. Включать под охоту за утечкой, где несобранный мусор как раз и подделывает рост heap. Метод, которого на движке нет, даёт `warning`, а не ошибку;
- снимок на `start` берётся **до** `Profiler.start`, на `stop` — **после** `Profiler.disable`, чтобы сами вызовы метрик не попали в запись, которую они описывают.

**Платформы**: tizen55 (Chromium 69) ✓, pc ✓, webos3 (Chrome 38) ✗ — домена `Performance` там нет. `action:"metrics"` на webos3 честно падает с сообщением про Chromium 60+; `start`/`stop` при этом работают как раньше и возвращают `metrics: null` плюс `warning` — потерять CPU-профиль из-за отсутствующих метрик нельзя. Фолбэка на `performance.memory` нет намеренно: на webOS значения квантованы и дают стабильную ложь вместо честного отказа.

В `tv_sequence` — шаг `{"metrics": true}`: им можно обрамить любой кусок сценария, не только тот, что покрыт записью профиля. Diff между двумя такими шагами считает вызывающий.

### tv_heap — снапшоты кучи и diff

Метрики говорят, **что** выросло (`JSHeapUsedSize`, `Nodes`); снапшот кучи — **кто** это держит. Охота на утечку:

```
tv_heap {"action": "snapshot", "path": "/tmp/before.heapsnapshot"}
tv_menu {"item": "Настройки"}   # сценарий: то, после чего память не возвращается
tv_menu {"item": "История"}
tv_heap {"action": "snapshot", "path": "/tmp/after.heapsnapshot"}
tv_heap {"action": "diff", "before": "/tmp/before.heapsnapshot", "after": "/tmp/after.heapsnapshot"}
```

`snapshot` отдаёт `path`, `bytes`, `chunks`, `durationMs` и `summary` — это Summary view в числах: `totalNodes`, `totalSize` (shallow), `detachedCount` и `topConstructors` (count + shallow size). `diff` — `delta` по тоталам плюс `topGrowth` / `topShrink`: `deltaCount`, `deltaBytes`, `countBefore`, `countAfter` по каждому конструктору, ровно как Comparison view.

Границы, они же причина хранить файл:

- **retained size (доминаторы) и retainer-пути не считаются.** Для «кто держит эту ноду» — открыть сохранённый файл в Chrome DevTools → **Memory → Load**. Тул отвечает на «что выросло», DevTools — на «за что зацепилось»;
- парсится только `nodes` + `strings`; `edges` (в разы больше) не читается — на нём и стоит ретейнер-граф;
- снапшот > 500 МБ не парсится вообще: `JSON.parse` такого файла стоит гигабайты RAM в Node. Ответ — `summary.ok:false` + `warning`, **файл при этом целый** и открывается в DevTools;
- **detached-ноды** ловятся двумя способами: по имени (`Detached HTMLDivElement`) и по колонке `detachedness` (есть с ~Chromium 80). Флагнутая, но не переименованная нода попадает в тот же бакет `Detached …`, чтобы diff видел рост одной строкой.

Снапшот пишется на диск **потоком**, по чанкам `HeapProfiler.addHeapSnapshotChunk` (37 МБ = ~365 чанков): держать кучу ТВ целиком ещё и в памяти MCP незачем. Оборванный снапшот (таймаут, разрыв сокета) удаляется — половина файла это невалидный JSON, который не откроет ни DevTools, ни парсер; в ошибке сказано, что файл удалён.

Снапшот **отвергается во время записи CPU-профиля**: это полный GC и длинная пауза V8, внутри записи она измеряла бы саму себя. Сначала `tv_profile action:"stop"`.

`action:"diff"` — чисто файловая операция: `device` не нужен, ТВ может быть выключен. Кэша нет, оба файла парсятся заново — кэш по пути соврал бы на перезаписанном снапшоте.

**Платформы**: pc ✓, tizen55 ✓, webos3 (Chrome 38) ✓ — `HeapProfiler` жив даже там (37 МБ / 406k нод / 13 с на живом LG 49UJ639V, diff после сценария показал +8.3 МБ и +1859 detached). Оговорка Chrome 38: у нативных нод `self_size` = 0, поэтому `detachedSize` там всегда 0 — считать надо `detachedCount`.

С `tv_sequence` намеренно не интегрирован: снапшот на слабом ТВ — это десятки секунд, тяжёлый шаг внутри сценария размыл бы тайминги остальных шагов. Порядок «снапшот → сценарий → снапшот → diff» точности окна не теряет.

## Парк устройств

`devices.json` (или путь в `TV_DEBUG_CONFIG`) — он в `.gitignore`, заводится копией `devices.example.json`. Файл перечитывается по mtime — правка подхватывается без рестарта MCP; дубли id и портов отвергаются с внятной ошибкой.

```json
{
  "defaultDevice": "tizen",
  "devices": [
    {"id": "tizen", "platform": "tizen", "app": "myapp", "appId": "AbCdEfGhIj.myapp",
     "host": "192.168.1.10", "sdbPort": 26101, "localPort": 9955},
    {"id": "webos", "platform": "webos", "app": "myapp", "appId": "com.example.myapp", "device": "webos7"},
    {"id": "pc-dev", "platform": "pc", "app": "myapp", "url": "http://localhost:1337"},
    {"id": "pc-dev-parity", "platform": "pc", "app": "myapp", "url": "http://localhost:1337",
     "inputMode": "synthetic"}
  ]
}
```

`cliTarget` (Tizen) можно не указывать — выводится из третьей колонки `sdb devices`; он нужен, чтобы `tizen install -t` попал в нужный ТВ на парке.

## App-профиль

`apps/<id>.json`, привязка полем `"app"`. Здесь живёт **всё знание о приложении** — чем помечен фокус, как выглядит сцена, где меню. Это то, что делает MCP переносимым: для другого приложения заводится второй файл, а не форк. Рабочий пример — `apps/fixture.json` (профиль встроенной фикстуры).

```json
{
  "focus": ["._active"],
  "scene": {"container": "._scene", "strip": "layer__container|fullscreen"},
  "popup": ["[class*=popup]", "[class*=context-menu]"],
  "menu": {"openKey": "LEFT", "exitKey": "BACK",
           "root": ".menu__primary", "item": ".menu__primary .menu-cell",
           "title": ".menu-cell__title"},
  "tile": ".video-tile, .media-tile",
  "bootReady": {"selector": ".video-tile", "timeoutMs": 40000},
  "checks": {"homeSection": "Main", "popup": ".context-menu"}
}
```

Два неочевидных момента, ради которых профиль вообще существует:

- Фреймворк может вешать класс фокуса на **всю цепочку** scene → container → list → tile, поэтому сфокусированный виджет — это **самый глубокий** match, а не первый. Первый — это сцена, и по нему навигация выглядит неподвижной.
- `root`/`item` пришивайте к **первому уровню** меню. Вложенный раздел легко рисует свои строки теми же классами, и одна из них может называться как раздел верхнего уровня — тогда матч по всему меню выбирает вложенную строку и рапортует успех, пока апп никуда не уходил. По той же причине есть `exitKey`: внутри раздела клавиша открытия меню может не возвращать в сайдбар, надо сначала выйти по BACK.

Необязательный блок `checks` читают приёмочные скрипты (`test/phase1-check.mjs`), чтобы не быть прибитыми к одному приложению: `homeSection` — раздел, в который возвращаемся после захода в меню, `popup` — как выглядит контекстное меню тайла.

## Браузерный режим (`platform: "pc"`)

Тот же набор тулов против локального Chrome. Быстро, и **скриншоты реально работают** — на Tizen они виснут.

- Chrome — **наш**: свой временный `--user-data-dir`, `--remote-debugging-port=0` (порт читается из `DevToolsActivePort`, а не прибит к 9333), гасится и подчищается на dispose. К обычному браузеру пользователя MCP не цепляется.
- Dev-сервер — **ваш**: MCP проверяет, что `url` отвечает, и не запускает и не гасит его. Запускать `npm start` в проекте приложения.
- `--disable-web-security` обязателен: приложение, чей бутстрап ходит за токеном на другой origin, без него умирает на CORS и не стартует.
- `Network.setCacheDisabled(true)` обязателен: dev-сервер отдаёт ES-модули, и переиспользованный браузер молча гоняет вчерашний код.

### Trusted vs synthetic — почему это два разных эксперимента

| | ТВ | Браузер по умолчанию | Браузер `inputMode: "synthetic"` |
|---|---|---|---|
| Механизм | page-side `KeyboardEvent` | `Input.dispatchKeyEvent` | page-side `KeyboardEvent` |
| `isTrusted` | нет | да | нет |
| Куда летит | `document` | реально сфокусированный элемент | `document` |
| Дефолтные действия браузера | нет | да | нет |

Кейс может быть зелёным в браузере и красным на ТВ (ветка TV-keyCode не задействована) — и наоборот (Backspace уводит браузер назад). Поэтому: **режим пишется в каждый вердикт**, тихого фолбэка между режимами нет, а навигационные кейсы прогоняются ещё и на `pc-dev-parity` перед выводом «на ТВ будет так же».

## Ключевые находки on-device (Tizen 5.5, sdb 4.2.36)

- **Debug-запуск**: `sdb -s <serial> shell 0 debug <appId>` **без** аргумента-таймаута. С таймаутом launchpad отвечает `closed`. Инспектор на device-порту переживает закрытие sdb-канала, поэтому канал закрывается сразу после разбора порта.
- **Надёжный kill** — `sdb shell 0 was_kill <appId>`. `kill_app` на retail-шелле молча no-op.
- **`attach` работает только через живой инспектор**: второй `debug` по уже отлаживаемому аппу отвечает `closed`. Порт берётся из памяти сессии или из правила `sdb forward --list`, которое переживает рестарт MCP; поэтому forward намеренно **не** снимается на dispose.
- **Скриншот `Page.captureScreenshot` виснет** (secure/overlay plane, HDCP) — тул отдаёт `ok:false` с пометкой. Для плейбека — `tv_video_state` + взгляд на ТВ.
- **localStorage переживает debug-релонч** на 5.5 (проверено: маркер на месте после `was_kill` + свежего `debug`).
- **Загрузка каталога — 3.6–6.1 с**, а не «22 секунды на всякий случай»: `tv_wait_for` быстрее и детерминированнее слепой паузы.
- **`relaunch` в браузерном режиме** переиспользует ту же throwaway-профиль-директорию, а Chrome оставляет в ней `DevToolsActivePort` от прошлого запуска. Файл сносится перед спавном — иначе адаптер отдаёт порт, на котором уже никто не слушает (`no inspectable page at http://127.0.0.1:…`).
- **Весь page-side JS — строго ES5**: `Array.prototype.find` появился в Chrome 45, а webOS 3 — это Chrome 38, и одна такая строчка роняла `tv_video_state` ровно на самом старом устройстве парка.

## Как это устроено

```
Claude Code ── stdio ── server.js
                         ├── config.js      devices.json (перечитка по mtime + валидация)
                         ├── appprofile.js  apps/<app>.json — знания о приложении
                         ├── adapters/
                         │    tizen.js      sdb -s: install/was_kill/debug/forward
                         │    webos.js      ares: close→launch→inspect
                         │    pc.js         свой Chrome + navigate + setCacheDisabled
                         │    spawn-until-match.js  общий супервизор CLI-детей
                         ├── input/
                         │    synthetic.js  page-side KeyboardEvent (ТВ + parity)
                         │    trusted.js    Input.dispatchKeyEvent (браузер)
                         ├── cdp.js         CDP по WebSocket, единый путь дисконнекта
                         ├── keymaps.js     KeySpec {code, key, domCode} по платформам
                         ├── inject.js      page-side ES5: key dispatch, focus, video-state
                         ├── state.js       page-side ES5: снимок состояния и фокуса
                         ├── wait.js        поллинг условий (общий для wait/goto/sequence)
                         ├── network.js     лог запросов: фильтры, curl, HAR
                         ├── profile.js     CPU-профиль: оба формата, саммари, sourcemap
                         ├── heap.js        .heapsnapshot: свод по конструкторам и diff
                         ├── ports.js       свободный локальный порт под forward
                         └── session.js     живая сессия: два лока, авто-реконнект, навигация
```

Устойчивость: упавший ТВ, выдернутый сокет или отсутствующий `sdb` валят **один вызов тула**, а не процесс MCP. `ensureConnected` сериализован — параллельные вызовы не запускают апп дважды.

## Проверено

| Прогон | Что |
|---|---|
| `npm run check:offline` | 138/138 — честный статус офлайн-устройства, перечитка конфига без рестарта, отказ при дублях id, выживание без `sdb`; парсер CPU-профиля на фикстурах обоих форматов (совпадающие числа, спец-узлы отдельно, рекурсия не удваивается) и деминификация топа с деградацией до `warning`; парсер `.heapsnapshot` (свод по конструкторам, detached по имени и по колонке `detachedness`, diff роста/убыли, движок без `detachedness`, битый файл) и `tv_heap action:"diff"` вообще без устройства; сетевой лог — жизненный цикл записи на событиях, скормленных сессии без сокета (редирект двумя хопами, отказ, ранний extra-info, вытеснение из буфера со счётчиком), фильтры, генератор curl (секреты, экранирование, warning'и) и сборка HAR, плюс семантика `expectRequest` (`absent` и `count.max` ждут всё окно) |
| `node test/phase0-check.mjs` | 18/18 на Samsung UE50TU8510 — launch, движение фокуса, ES5-проба видео, `limit:1`, attach из другого процесса с сохранением состояния, выживание при обрыве сокета |
| `node test/phase1-check.mjs` | 12/12 на ТВ — `wait_for` вместо сна, структурный фокус, `goto` до цели и его границы, заход в раздел меню и возврат обратно, кейс лонгтапа целиком. Селекторы берутся из app-профиля устройства, поэтому прогон не привязан к конкретному приложению |
| `npm run check:webos2` | 15/15 на LG 40UF771V (webOS 2.2 / WebKit 538.2) — движок без CDP: аттач через `/pagelist.json`, page-side throw доезжает ошибкой (`wasThrown`, а не тихий `undefined`), фокус двигается через `createEvent`-фолбэк, `tv_console` ловит `Console.messageAdded`, скриншот отказывает честно и сессия его переживает, `tv_sequence` проходит целиком. Устройство задаётся `TV_DEBUG_DEVICE`, по умолчанию `webos2` |
| `npm run check:browser` | 75/75 в Chrome — capabilities, отказ `tv_install`, свой Chrome на порту 0, навигация, реальный скриншот, кейс лонгтапа в trusted и synthetic, CPU-профиль (именованная busy-функция видна в топе, двойной `start` и сиротский `stop` отвергнуты, профилирование шагами сценария), `tv_heap` (файл на диске, подсаженная утечка `TvDebugLeakItem` видна в diff по имени вместе с detached-нодами, снапшот во время записи профиля отвергнут), `tv_network` (`expectRequest` по телу реального XHR, негативный ассерт, упавший запрос с `errorText`, чтение тела ответа, сгенерированный curl **исполняется шеллом** и доносит тело до сервера, HAR парсится как 1.2), уборка за собой |
| `tv_heap` on-device | LG 49UJ639V (webOS 3.9 / Chrome 38): снапшот 37 МБ / 406k нод / 1271 detached за 13 с; после сценария diff показал +8.3 МБ, +170k нод, +1859 detached с разбивкой по конструкторам. Целевой webos7 на момент прогона был недоступен |
| `tv_network` on-device | LG 49UJ639V (webOS 3.9 / Chrome 38): `expectRequest` по телу реального стат-запроса зелёный на живой навигации, красная ветка падает по таймауту с причиной, `absent` выжидает всё окно; `body` читает ответ, сгенерированный curl воспроизводится в терминале (200), HAR на 361 запись собрался с 360 телами и настоящими таймингами |

Что этот движок умеет и чего нет, видно по прогону выше: `postData` приходит прямо в `requestWillBeSent`, редиректы и `getResponseBody` работают, а `*ExtraInfo` нет (Chromium <63) — заголовки в логе до-движковые, без `Cookie`, о чём curl предупреждает. `resourceType` на Chrome 38 врёт (главный документ пришёл как `Image`), фильтровать надо по URL.

webOS-адаптер (close → launch → inspect, честный `freshLaunch`) прогнан on-device на LG 49UJ639V; остальные LG из `ares-setup-device --list` бывают недоступны (connection timed out) — это про сеть, не про адаптер.

Диалект `Runtime.evaluate` определяется по протоколу, а не по движку, поэтому двухзвонковый сэмпл берут все до-M54 движки. Проверено on-device на LG (webOS 4 / Chromium 53): `awaitPromise: true` там тоже отдаёт `{}`, то есть промисное выражение возвращало пустой объект и `tv_video_state` на этом устройстве был тихо сломан — теперь отдаёт полный набор полей. Слоты сэмпла ведут себя так же, как на webOS 2 (два токена сосуществуют, потерянный отвечает `sampleLost`, на странице ничего не остаётся). Tizen 3 (Chromium 47) из той же протокольной эпохи, но on-device не проверен: устройство отвечает `closed` на `sdb shell 0 debug` — инспектор не открывается, это состояние ТВ.

`tv_video_state` on-device на webOS 2: `awaitPromise: true` на этом движке отдаёт `{}` — промис не дожидается, поэтому промисное выражение там бесполезно и сэмпл идёт двумя вызовами с паузой на стороне хоста. На играющем видео — `advancing: true`, `advancedBy: 2` за паузу 2000 мс, 1920×800. Слот сэмпла ключуется по номеру вызова: два перекрывающихся сэмпла вернули независимые результаты (`advancedBy` 21.52 и 11.48 от своих баз), потерянный слот отвечает `sampleLost`, а не выдуманным сэмплом, и на странице не остаётся ничего. Лока здесь намеренно нет: `tv_sequence` уже держит операционный лок на шаге `{"videoState":true}`, а он не реентрантный.

`test/smoke.mjs` — ad-hoc прогон произвольного списка вызовов; `test/harness.mjs` — общий stdio-клиент для всех проверок и хелпер `appTargets`, который вытаскивает селекторы из app-профиля.

`check:browser` дополнительно прогоняется против вашего живого dev-сервера, если задать обе переменные:

```bash
TV_DEV_URL=http://localhost:1337 TV_DEV_APP=myapp npm run check:browser
```

## Демо-кейсы

`cases/fixture-smoke.md` — кейс против встроенной фикстуры, исполним сразу после клона, без ТВ и без dev-сервера. Формат и правила, выведенные из реальных прогонов, — в `cases/README.md`.

## Дальше

- webOS on-device прогон (в т.ч. webOS 3 = Chrome 38: ES5-инъекция, работоспособность скриншота и **легаси-формат CPU-профиля** — парсер написан по спецификации Chrome 38 и проверен на фикстуре, но не на живом LG).
- Прогон `tv_profile` на ТВ с `sourceMap` от прод-сборки (карта Closure парсится и позиции разрешаются — проверено офлайн).
- `tv_network` on-device: приёмка «инструмент отвечает на исходный вопрос» — переход по разделам и зелёный `expectRequest` по аналитике на здоровой сборке; на webOS 3 (Chrome 38) факт-чек протокола: `postData` в `requestWillBeSent`, `getResponseBody`, поведение по редиректам. Пока прогонялось только в браузере.
- Остальные перф-инструменты (FPS, `Tracing`) — отдельным заходом, они не покрывают весь парк.
- Sampling heap profiler (`HeapProfiler.startSampling`/`stopSampling`) — кто **аллоцирует**; `tv_heap` отвечает на другой вопрос (кто держит уже живую память).
- Авто-повтор удержанной d-pad-клавиши (`holdRepeatMs`): сейчас `durationMs` шлёт один `keydown`, что верно для лонгтапа, но не воспроизводит скролл ленты зажатой стрелкой. Обход списков закрывает `tv_goto`.
- Параллельный прогон одного кейса на N ТВ (адресация `-s` для этого уже есть).
- Allure TestOps (чтение кейсов) + `allurectl` (заливка результатов).
- WS-пульт (SSAP / Samsung remote) для системных кейсов HOME/suspend, которые page-level синтетика не покрывает.
