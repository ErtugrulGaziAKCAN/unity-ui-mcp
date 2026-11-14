# unity-ui-mcp kullanım rehberi

Oyun ekranlarını Claude Design'da çizen tasarımcılar ve bu ekranları oyuna koyan Unity geliştiricileri için. Akışın
tamamını sade bir dille anlatır. Kurulum [README](../../README.md) ve [INSTALL.md](../../INSTALL.md) dosyalarında,
tasarım kurallarının kesin hâli [RULES.md](../../design-kit/RULES.md) dosyasındadır. İngilizcesi:
[usage.md](usage.md).

## Akış

```
Unity projesi ── kit senkronu: fontlar, font token'ları, yazı stilleri ──► design kit
design kit ── design-export kit claude ──► Claude Design'da Design System
Claude Design: tasarla → varyant iste → seç → revize ettir (her ekran için bir artboard, 2560×1440)
AI istemcisi: /unity-ui-mcp + canvas bağlantısı ── MCP ──► lint → açık Unity editörüne aktar → doğrula → rapor
Unity: derlenmiş ekran + üretilen View sınıfı ──► oyun kodunda yazılan presenter
```

Sistem tasarımı yorumlamaz. Tasarımı gerçek bir tarayıcıda ölçer, tam olarak onu UI Toolkit'e derler ve Unity'nin
çizdiğini tarayıcının çizdiğiyle karşılaştırır. Kurallara uymayan tasarım lint'te durur; kural kodu ve düzeltmesi
söylenir. Aktarımdan sonra çıkan bir fark raporlanır, asla gizlice yaklaştırılmaz.

## Her proje için bir kez

1. **Kur** (README, üç adım). Unity'de `Window > Design UI > Status` penceresi köprünün durumunu gösterir.
2. **Profili oluştur:** aynı pencerede **Create Profile**. `DesignUiProfile` projeye özel her ayarı tutar: üretilen
   ekranların klasörü (`outputFolder`, varsayılan `Assets/UI/Generated`) ve namespace'i, çözünürlükler, diller, fontlar,
   localization, sağdan sola kuralları, yazı boyutları ve ekranların uGUI kabuğuna nasıl yerleşeceği.
3. **Fontlar.** Her dil, projenin zaten kullandığı TMP fontuyla çizilir. Varsayılan olarak bu, her dil için TMP
   Settings'teki varsayılan fonttur. Dile göre font eşlemesi olan bir proje profildeki **Locale Fonts** listesini
   doldurur ya da bir Editor assembly'sinde kendi font sistemine soran küçük bir `DesignUiFontResolver` alt sınıfı yazıp
   onun asset'ini profilin **Font Resolver** alanına koyar (tek doğru kaynak).
4. **Kit.** `design-kit` klasörünü klondan kendine ait bir yere kopyala (örneğin tasarımların yanına) ve
   `design-ui.config.json` içindeki `kitDir`'i oraya çevir; klon temiz kalır. Sonra **kit senkronu** yap (AI'dan
   `design_ui_kit_sync` iste ya da `Window > Design UI > Kit Sync`): projenin font dosyaları kit'e kopyalanır,
   `--font-*` token'larına fontların gerçek aile adları yazılır, yazı stilleri fontların gerçek yüzlerine göre denetlenir.
5. **Kit'i Claude Design'a yayınla.** `/unity-ui-mcp`'den kit'i yayınlamasını iste ya da klonda
   `npx design-export kit claude <kitDir> <outDir>` çalıştırıp `<outDir>/project/` klasörünü Design System olarak
   yayınla. Bir şeyi değiştiren her kit senkronundan sonra tekrarla.
6. **Sağdan sola ve karmaşık yazılar** (Arapça ve diğerleri): Play'e girmeden önce **Project Settings > UI Toolkit >
   Enable Advanced Text** ayarını aç; oyuncunun kullandığı her PanelSettings'e ICU verisini ver
   ([ayrıntılar](../findings/advanced-text.md)).
7. **Localization** (isteğe bağlı): Unity Localization 1.5 veya üstü. Profilin localization ayarlarında her ekranın
   String Table koleksiyonunu (ya da varsayılan bir adlandırma kalıbını) ve tablolarının argüman biçimini (`{name}` Smart
   String ya da `{0}` sıralı) belirt.
8. **Doğrulama görüntüleri:** bir yakalama komutu kur (aşağıda). Kurulana kadar lint ve aktarma çalışır, doğrulama da
   neyin eksik olduğunu söyler.

## Claude Design'da tasarlamak

Kit'in Design System'ini canvas'a ekle. Sonra:

- **Her ekran için bir artboard.** Başlığı ekran kimliği olsun (`club.overview`); kökü sabit 2560×1440 olsun ve
  `data-u-screen="club.overview"` taşısın. Ekranlar 2560×1440, 1920×1080 ve 1280×720'de doğrulanır.
- **Stil, kit'in temel stil sayfasıyla başlar** (design system içinde gelir); renk, boşluk ve köşe için token kullan:
  `var(--color-surface-700)`, `var(--space-4)`, `var(--radius-md)`.
- **Yerleşim yalnız flex ile.** Grid, `calc()`, `vw`/`vh`, float ya da `position: fixed` yok. `gap` yalnız satır
  kaydırmayan kapsayıcılarda. İçeriği küçülmemesi gereken flex elemanlarına açık bir boyut ya da `flex-shrink: 0` ver.
- **Her metin kit'teki bir yazı stili sınıfını kullanır** (`.text-body`, `.text-title-bold`, …): 12 ile 64 px arası
  boyutlar, 400 ve 700 kalınlık. Metin kendi elemanında durur.
- **Görünen her metnin bir anahtarı vardır.** Metni referans dilde (kit'te Türkçe) yaz; `data-l10n="club.overview.title"`
  (anlamlı İngilizce bir anahtar) ve `data-en="Overview"` ekle. Cümle içindeki bir değer
  `<span data-u-arg="count">3</span>` olur ve `data-en`'de `{count}` diye yazılır. Oyundan gelen ve çevrilmeyen değerler
  (oyuncu adı, bir sayı) `data-u-bind="player-name"` kullanır; metni yalnız örnek veridir.
- **Kontrollerin kimliği olur.** Her buton, girdi ya da bağlı eleman `data-u-id` taşır; bir şey yapan elemanda
  `data-u-action="open-inbox"` bulunur. Bir elemanda tek aksiyon.
- **Durumlar.** Etkileşim durumları `:hover`, `:active`, `:focus`, `:disabled`, `:checked`. Seçili sekme ya da satır
  bir `is-*` sınıfıdır (`.tab.is-selected`). Ekran durumları (`loading`, `empty`, `error`) `data-u-state="loading"`
  taşıyan köklerdir ve ekran kökündeki `.state-loading` altında görünür.
- **Listeler.** Satırları örnek olarak tek tek yaz, ilkine `data-u-repeat="player"` koy; diğer örnekler onunla aynı
  yapıda olur. Kaydırma alanı (`overflow-y: auto`) içindeki liste sanal bir `ListView` olur. Sonraki bir satır iç içe
  listeyi boş bırakabilir (etkinliği olmayan bir gün); ilk satır en az bir öğe yazar. Bir elemanı yalnız bazı satırlarda
  göstermek için (bir rozet) diğerlerinde `hidden` özniteliğiyle gizle ve ona `data-u-id` ver; oyun onu satır satır
  gösterir ya da gizler. Bütün bir satırı asla gizleme: o satırı hiç yazma.
- **Görünüm.** Gölgeler (`box-shadow`, `inset` dahil) ve gradyanlar serbest; görsele çevrilerek aktarılır. 8 px'ten ince
  kenarlıklar ve çizgiler tam cihaz pikselinde kalır. 1'den küçük opacity yalnız parçaları üst üste binmeyen
  elemanlarda; devre dışı kontroller için kit'in disabled renklerini kullan. İkonlar `currentColor` ile (metin rengini
  izler) ya da sabit renklerle boyanmış satır içi `<svg>`'dir. Görseller yüklenmiş dosyalardır; ağdan bir şey yüklenmez.
- **Hareket.** Transform'ların (`translate`, `rotate`, `scale`), `opacity`'nin, renklerin ve köşe yarıçaplarının
  geçişleri ve `@keyframes` animasyonları; tetikleyici ekranın açılması, bir durum, bir etkileşim durumu ya da bir
  `is-*` sınıfıdır. Boyut ya da konum değişimi `width` ya da `top` ile değil, `translate` ya da `scale` ile yapılır.
- **Oyunun zaten çizdiği alanlar** (mevcut üst bar ya da yan menü) `data-u-external` ile işaretlenmiş yer tutuculardır:
  kutuları korunur, Unity'de hiçbir şey çizmezler ve karşılaştırmada maskelenirler.

İyi çalışan bir istek:

> Ekli design system'i kullan ve README'sindeki kurallara uy. Ekran kimliği `club.overview`, tek bir 2560×1440 artboard.
> Görünen metinleri Türkçe yaz; her metne İngilizce `data-l10n` anahtarı ve `data-en` İngilizce metni ekle. Her butona
> `data-u-id` ve `data-u-action` ver. Yalnız kit'in yazı stili sınıflarını ve token'larını kullan, yalnız flex yerleşim,
> grid ya da calc yok. Oyuncu listesini beş örnek satır olarak yaz, ilkine `data-u-repeat="player"` koy. Mevcut üst
> barı `data-u-external` ile işaretle.

HTML'i başka bir AI yazacaksa aynı sözleşmeyi `design_ui_rules` aracıyla okuyabilir.

## Ekranı Unity'ye getirmek

AI istemcinde `/unity-ui-mcp` yaz, canvas bağlantısını ver ve artboard'u söyle (ya da `designRoot` altındaki bir
klasörü göster). Skill araçları ve Unity köprüsünü kontrol eder, kuralları okur, artboard'u ve görsellerini
`<designRoot>/<ekran-id>/` altına kaydeder, sonra:

1. **Lint** (`design_ui_lint`). Her bulgu bir kural, eleman ve düzeltme söyler. Tasarımı Claude Design'da düzelt;
   üretilen dosyalara asla yama yapma.
2. **Aktar** (`design_ui_import`). Tasarım Chromium'da dışa aktarılır (IR, her yakalama işi için bir golden görüntü,
   pişirilmiş görseller, örnek veri; `<designRoot>/<ekran-id>/.design-ui/export/`), sonra köprü üzerinden açık editöre
   derlenir: `<outputFolder>/<Ekran>/` altına `<Ekran>.uxml`, `<Ekran>.uss`, her liste için bir öğe şablonu,
   `<Ekran>View.g.cs`, görseller ve bir manifest; `<outputFolder>/` altına ortak `DesignTokens.uss` ve `DesignFonts.uss`.
   Localization açıksa ekranın metinleri String Table koleksiyonuna yazılır. Aktarma şunları raporlar: bekleyen
   çeviriler, çakışmalar (başka metni olan var olan bir anahtar asla ezilmez), bir dilin fontunda olmayan karakterler ve
   tasarımın gizlediği yakalama işleri.
3. **Doğrula** (`design_ui_verify`). Unity derlenmiş ekranı projenin bir kopyasında her yakalama işi için çizer (her
   çözünürlük, durum, sınıf, etkileşim durumu, liste örneği ve animasyon örneği) ve tasarımla karşılaştırır. Sonuç
   `pass`, `fail` ya da `incomplete` olur; rapor `<designRoot>/<ekran-id>/report.html` dosyasındadır.

**Raporu okumak.** Her yakalama tasarımı, Unity'yi, üst üste bindirmeyi ve fark görüntüsünü gösterir; sorunlu
elemanlar çerçevelenir ve sorun adıyla yazılır: 1 px'ten fazla kayan bir kutu, yanlış bir satır kırılması ya da taban
çizgisi, bir renk, yapısal benzerlikte (SSIM) bir düşüş, fazla ince ya da kalın çizilmiş metin. `incomplete`, bir işin
tasarımın hiçbir durumunda, sınıfında ya da örnek satırında görünmeyen bir elemanı gösterdiği anlamına gelir:
karşılaştırılacak bir şey yoktur. Asla geçti sayılmaz; elemanı bir bağlamda görünür yap ya da kaldır.

**Tasarımı sonradan değiştirmek** aynı akıştır. Değişmeyen tasarım yeniden dışa aktarılmaz; yalnız stil değiştiyse
yalnız USS yeniden yazılır ve scriptler yeniden derlenmez. Aktarma, elle değiştirilmiş üretilmiş bir dosyanın üzerine
yazmaz ve onu listeler; değişikliği tasarıma taşı ya da bilerek `discardManualEdits` ver.

## Ekranı oyun koduna bağlamak

Oyunun dokunduğu tek kod üretilen View sınıfıdır. Ona veri veren ve olaylarını işleyen presenter senin kodundur.

**Ekranı göstermek.** UI'nın altına kaynağı ekranın `<Ekran>.uxml` dosyası olan ve profilin PanelSettings'ini
(varsayılan: paketin `DesignUiPanelSettings`'i) kullanan bir `UIDocument` koy. uGUI kabuğunun içindeysen ekranın
dolduracağı RectTransform'a `DesignUiPanelRegion` ekle: ekran o dikdörtgeni izler, kabuğun canvas'larıyla doğru sırada
çizilir (profilin `host` ayarları), dilin fontlarını ve sağdan sola kurallarını uygular, sana `IsPointerOverPanel`,
`EscapePressed`, `FocusEntered` ve `FocusLeft` bilgisini verir.

```csharp
using UnityEngine;
using UnityEngine.UIElements;
using DesignUi;
using DesignUi.Generated;            // profildeki namespace

public sealed class ClubOverviewHost : MonoBehaviour
{
    [SerializeField] DesignUiPanelRegion region;
    ClubOverviewView view;

    void OnEnable()
    {
        Bind(region.Document.rootVisualElement);
        region.RootRebuilt += Bind;          // Unity belgenin kökünü yeniden kurdu: View'u yeniden oluştur
    }

    void OnDisable() => region.RootRebuilt -= Bind;

    void Bind(VisualElement root)
    {
        view = new ClubOverviewView(root);
        view.OpenInboxRequested += OpenInbox;
        Render(ClubService.Current);         // oyunun gerçek verisi, asla örnek veri değil
    }

    void Render(Club club)
    {
        view.SetState(club.IsLoading ? ClubOverviewView.State.Loading : ClubOverviewView.State.Default);
        view.SetClubName(club.Name);
        view.SetPlayer(club.Players.Count, (item, i) =>
        {
            var p = club.Players[i];
            item.SetPlayerName(p.Name);
            item.SetBadgeVisible(p.IsInjured);
            item.OpenPlayerRequested += () => OpenPlayer(p);   // öğe olayları her bağlamadan önce temizlenir
        });
    }
}
```

View'un sundukları:

| Tasarımda | View'da |
|---|---|
| `data-u-id="save"` | türü belli bir özellik: `view.Save` (`Button`, `Label`, `Toggle`, `TextField`, `DropdownField`, `ListView`, …) |
| `data-u-bind="club-name"` | `SetClubName(string)`; bağlı bir görsel: `SetCrest(Background)` |
| Çevrilen metin içinde `{count}` | `SetCount(string)` |
| `data-u-action="open-inbox"` | `event Action OpenInboxRequested` |
| `data-u-state="loading"` | `SetState(State.Loading)` |
| `.is-selected`, her `is-*` sınıfı | `SetSelected(element, bool)`, `SetClass(element, "is-open", bool)` |
| `:disabled` görünümü | `SetEnabled(element, bool)` |
| `data-u-repeat="player"` | her öğe için bir `PlayerItemView` ile `SetPlayer(count, (item, index) => …)` |
| Bazı örnek satırlarda gizlenen eleman | `item.Set<Id>Visible(bool)` |

Setter'lar değişmeyen değeri yazmaz ve sabit durumda bellek ayırmaz; veri her değiştiğinde çağırmak sorun değildir.
Girdilere değer, değişiklik olayı tetiklenmeden yazılır. Üretilen dosya bir assembly definition altındaysa onun
referanslarına `DesignUi.Runtime` ekle.

**Diller.** Metinler String Table girdilerine bağlıdır; seçili dil değişince metin ve font ekran açıkken değişir.
Bölge varsayılan olarak Unity Localization'ın seçili dilini izler (`LocaleSource` bunu değiştirir). Aktarmanın
"çeviri bekliyor" dediği metinler projenin yedek dil zinciriyle İngilizceye düşer. Sağdan sola diller profilin hizalama
kuralını alır (başa hizalı metin sağa döner, yerleşim aynalanmaz); Enable Advanced Text açıksa harfler bitişik ve doğru
yönde çizilir.

**Yazı boyutu.** Oyunun yazı boyutu seçeneklerini (anahtar ve ölçek) profilin `textSizes` listesine yaz ve yeniden
aktar; bölgenin `TextSizes` alanına `IDesignTextSizeSource` uygulayan bir bileşen ver (oyunun ayarı).

**Hareket.** Animasyonlar kendiliğinden oynar. Bir erişilebilirlik ayarı için
`if (DesignUiAnimationPlayer.For(view.Root) is { } motion) motion.ReducedMotion = true;` yaz (animasyonu olmayan
ekranın oynatıcısı yoktur): geçişler sona atlar, animasyonlar duran karelerini gösterir.

## Doğrulama görüntüleri

`design_ui_verify` açık editörünü hiçbir zaman kullanmaz. `design-ui.config.json` içindeki
`unityRunner.command.capture` komutunu çalıştırır. Bu komut projenin bir **kopyasında** çizmelidir (Unity aynı projeyi
iki kez açamaz); kopyada derlenmiş ekran bulunmalı ve `Packages/manifest.json` paketin testlerini listelemelidir
(`"testables": ["com.unity.design-ui"]`). Komut, EditMode testi
`DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv`'i batchmode'da çalıştırır; sunucu dışa aktarım ve çıktı
klasörlerini ortam değişkenleriyle verir (`DESIGN_UI_EXPORT_DIR`, `DESIGN_UI_OUT_DIR`; `{exportDir}` ve `{outDir}`
yer tutucuları olarak da). Kendine uyarlayacağın bir örnek:

```json
"unityRunner": {
  "prefer": "editor",
  "captureVia": "command",
  "timeoutSec": 3600,
  "command": { "import": [], "kitSync": [], "capture": ["/path/to/capture-on-copy.sh", "{projectDir}"] }
}
```

```sh
#!/bin/sh
# capture-on-copy.sh <projectDir>: projenin kopyasını tazele, sonra yakalamayı orada yap.
set -e
COPY="$HOME/UnityCopies/$(basename "$1")-capture"
mkdir -p "$COPY"
rsync -a --delete --exclude Temp --exclude Logs --exclude UserSettings "$1/" "$COPY/"
exec "/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity" -batchmode -projectPath "$COPY" \
  -runTests -testPlatform EditMode -testFilter "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" \
  -testResults "$COPY/capture-results.xml" -logFile -
```

Yakalama, çıktı klasörüne her iş için bir PNG, `boxes.json`, `boxes.meta.json` ve en son `capture-done.json` yazar;
sunucu ardından karşılaştırır ve raporu yazar. Başarısız olan, zaman aşımına uğrayan ya da bitmeyen bir çalışma, yarım
kalan görüntülerini, meta dosyasını ve Unity günlüğünü `<designRoot>/<ekran-id>/.design-ui/failed-<run>/` altında tutar.
Her kopya kendi `Library` klasörünü taşır (çoğu zaman birkaç GB): diske dikkat et. Komut senin yetkilerinle bir program
olarak çalışır; yalnız güvendiğin ayar dosyalarını kullan.

## AI istemcisi olmadan

Aynı adımlar komut satırından ve Unity'den de çalışır:

```sh
npx design-export lint <tasarım klasörü ya da sayfası> --kit <kitDir>
npx design-export export <tasarım> --kit <kitDir> --out <exportDir>
npx design-export compare <exportDir> --unity <captureDir> --report report.html
npx design-export kit build <kitDir> --check
npx design-export kit claude <kitDir> <outDir>
```

Unity'de: `Window > Design UI > Import Screen…` ve `Window > Design UI > Kit Sync`; batchmode'da
`-executeMethod DesignUi.Editor.DesignUiBatch.Import -designUiProfile <asset> -designUiExport <exportDir>` ve
`-executeMethod DesignUi.Editor.DesignUiBatch.KitSync -designUiProfile <asset> -designUiKit <kitDir>`.

## Sık görülen lint bulguları

| Kural | Anlamı | Düzeltme |
|---|---|---|
| U-CSS-001 | `display: grid` | iç içe flex satır ve sütunları |
| U-CSS-005, U-CSS-006 | `calc()`, `vw`/`vh` | px ya da % |
| U-CSS-010 | kit'e ait olmayan bir font | `var(--font-ui)`; kit senkronundan sonra token'ın yeni ailesi |
| U-CSS-011 | satır kaydıran kapsayıcıda `gap` | öğelere margin |
| U-CSS-016 | kit yazı stili olmayan bir boyut, satır yüksekliği ya da kalınlık | bir `.text-<stil>` sınıfı |
| U-CSS-019 | içeriğinin altına küçülen bir öğe | `flex-shrink: 0` ya da açık bir boyut |
| U-CSS-038 | gri tonlamalı yumuşatması olmayan metin | kit'in temel stil sayfasını koru |
| U-CSS-039 | parçaları üst üste binen elemanda 1'den küçük opacity | kit'in disabled renkleri |
| U-CSS-040 | cihaz pikseline oturmayan ince bir kenarlık ya da çizgi | listelenen uzunluklar |
| U-CSS-013, U-CSS-042 | yerleşim özelliğinin animasyonu | `translate` ya da `scale` |
| U-MRK-003 | `data-u-id`'si olmayan kontrol, bağlı ya da aksiyonlu eleman | bir kimlik ekle |
| U-MRK-004 | `data-l10n` ve `data-en`'i olmayan görünür metin | anahtarı ve İngilizce metni ekle |
| U-MRK-005 | izin verilmeyen karakterli kimlik ya da anahtar (`İ`, `ı`, `ş`, rakamla başlama) | ASCII karşılığı |
| U-MRK-013 | kendi işaretlemesiyle gizlenmiş örnek satır | o satırı hiç yazma |
| U-FONT-001 | fontta gerçek yüzü olmayan kalınlık ya da italik | 400 ya da 700, ya da yüzü Unity'de ekleyip kit'i senkronla |
| U-FONT-003 | kit fontunda olmayan bir karakter | fontun kapsadığı karakterler ya da onları içeren bir font |

Her düzeltmesiyle tam liste [RULES.md](../../design-kit/RULES.md#lint-rules) dosyasındadır. Lint dışındaki sorunlar
için README'deki [sorun giderme](../../README.md#troubleshooting) tablosuna bak.
