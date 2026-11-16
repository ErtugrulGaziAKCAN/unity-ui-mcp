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
   localization, sağdan sola kuralları, yazı boyutları ve ekranların uGUI kabuğuna nasıl yerleşeceği. **Reference Locale**
   tasarımların yazıldığı dildir: yeni bir profilde İngilizce (`en`). Başka bir dilde tasarlamak için (örneğin `tr`)
   ilk kit sync'ten önce ayarla; kit sync onu kit'in `locales` listesine yazar, böylece RULES.md, yayımlanan Design
   System ve lint o dili söyler, import da tasarımların metnini o dilin String Table girdileri olarak yazar. Bir profil
   kaydedildiği değeri korur.
3. **Fontlar.** Her dil, projenin zaten kullandığı TMP fontuyla çizilir. Varsayılan olarak bu, her dil için TMP
   Settings'teki varsayılan fonttur. Dile göre font eşlemesi olan bir proje profildeki **Locale Fonts** listesini
   doldurur ya da bir Editor assembly'sinde kendi font sistemine soran küçük bir `DesignUiFontResolver` alt sınıfı yazıp
   onun asset'ini profilin **Font Resolver** alanına koyar (tek doğru kaynak).
4. **Kit.** Kurulum `design-kit` klasörünü klondan projenin kendi kiti olan `<designRoot>/design-kit` klasörüne
   kopyalar ve `kitDir`'i oraya çevirir (kit senkronu klona hiç yazmaz). Sonra **kit senkronu** yap (AI'dan
   `design_ui_kit_sync` iste ya da `Window > Design UI > Kit Sync`): projenin font dosyaları kit'e kopyalanır,
   `--font-*` token'larına fontların gerçek aile adları yazılır, yazı stilleri fontların gerçek yüzlerine göre denetlenir.
   Kurulum var olan bir kit'i olduğu gibi bırakır; klonu güncelledikten sonra klonda
   `npx design-export kit upgrade <kitDir> --dry-run` ile neyin değişeceğini gör, sonra `--dry-run` olmadan çalıştır:
   klonun temel stil dosyası, kuralları, bileşenleri, yazı stilleri ve ayar anahtarları gelir; projenin fontları, kendi ve
   değiştirdiği token'ları (eski bir klonun değeri yenisini alır), kendi bileşenleri ve liste girdileri (daralttığı bir liste dar kalır, bunu kit'in geldiği klon ayarını tutan `.kit-base.json` söyler; okunamayan bir
   components.json yükseltmeyi durdurur), dilleri, kendi
   anahtarları ve ek görünümleri kalır; değiştirilen dosyalar `<kitDir>/.backup/<UTC zamanı>/files/` altına yedeklenir,
   `kit-upgrade.json` neyin değiştirilip eklendiğini listeler ve komut kit'i geri yükleyen komutu yazar. Eski bir
   profilin eksik görünümlerini `Window > Design UI > Add Default Viewports to Profile` ekler (yalnız 2560×1440 referanslı
   profile; Undo açık profili geri alır, diske yazmak için projeyi kaydet). Kit sync eksik ya da okuyamadığı bir görünümü
   düşürmez, söyler.
5. **Kit'i Claude Design'a yayınla.** `/unity-ui-mcp`'den kit'i yayınlamasını iste ya da klonda
   `npx design-export kit claude <kitDir> <outDir>` çalıştırıp `<outDir>/project/` klasörünü Design System olarak
   yayınla. Bir şeyi değiştiren her kit senkronundan sonra tekrarla.
6. **Sağdan sola ve karmaşık yazılar** (Arapça ve diğerleri): Play'e girmeden önce **Project Settings > UI Toolkit >
   Enable Advanced Text** ayarını aç; oyuncunun kullandığı her PanelSettings'e ICU verisini ver
   ([ayrıntılar](../findings/advanced-text.md)).
7. **Localization** (isteğe bağlı): Unity Localization 1.5 veya üstü. Profilin localization ayarlarında her ekranın
   String Table koleksiyonunu (ya da varsayılan bir adlandırma kalıbını) ve tablolarının argüman biçimini (`{name}` Smart
   String ya da `{0}` sıralı) belirt.
8. **Çözünürlükler.** Oyunun sunduğu her çözünürlüğü profilde bildir (yeni bir profil kit'in altı çözünürlüğüyle başlar;
   bu sürümden önce kaydedilmiş bir profil kendi listesini korur). **Viewports** (tam, exact): panel ölçeği kit'in
   4 px ızgarasını tam tutanlar (2560×1440 referansıyla 3840×2160, 2560×1440, 1920×1080, 1280×720); orada her yazı
   boyutu, satır yüksekliği ve kenarlık tam cihaz pikselidir, lint, kit build ve kit sync tasarımı buna göre denetler.
   **Scaled Viewports** (ölçekli) oyuncuların kullandığı diğerleri (1600×900, 1366×768): orada hiçbir tasarım değeri tam
   olamaz, bu yüzden bu kurallardan muaftır; verify yine de yerleşimi aynı ±1 cihaz pikseli sınırıyla denetler. Böyle
   bir ölçekte ekranın paneli bir üstteki tam ölçekte yerleşir (1600×900 ve 1366×768'de 0,75) ve ekran kökü gerçek
   ölçeğe küçültülüp büyütülerek çizilir: her kenar ve her yazı satırı tasarımın koyduğu yere düşer. Kit sync iki listeyi
   de `kit.config.json`'a yazar; ikisinde de olmayan bir çözünürlük aynı yolla yerleşir ama doğrulanmaz.
9. **Doğrulama görüntüleri:** kurulumun yazdığı yakalama komutu projenin geçici bir kopyasında çizer (aşağıda); projenin
   sürümündeki Unity Hub kurulumunu ya da `UNITY_BIN`'i kullanır.

## Claude Design'da tasarlamak

Kit'in Design System'ini canvas'a ekle. Sonra:

- **Her ekran için bir artboard.** Başlığı ekran kimliği olsun (`club.overview`); kökü sabit 2560×1440 olsun ve
  `data-u-screen="club.overview"` taşısın. Ekranlar kit'in bildirdiği her çözünürlükte doğrulanır: varsayılan olarak
  tam (exact) 3840×2160, 2560×1440, 1920×1080 ve 1280×720 ile ölçekli (scaled) 1600×900 ve 1366×768 (aşağıda). Ölçekli
  bir çözünürlük için tasarımda hiçbir şey değişmez.
- **Stil, kit'in temel stil sayfasıyla başlar** (design system içinde gelir); renk, boşluk ve köşe için token kullan:
  `var(--color-surface-700)`, `var(--space-4)`, `var(--radius-md)`.
- **Yerleşim yalnız flex ile.** Grid, `calc()`, `vw`/`vh`, float ya da `position: fixed` yok. `gap` yalnız satır
  kaydırmayan kapsayıcılarda. İçeriği küçülmemesi gereken flex elemanlarına açık bir boyut ya da `flex-shrink: 0` ver.
- **Her metin kit'teki bir yazı stili sınıfını kullanır** (`.text-body`, `.text-title-bold`, …): 20 ile 64 px arası
  boyutlar, 400 ve 700 kalınlık. **Okunabilir en küçük boyutun altında metin yok:** hiçbir metin, bildirilen hiçbir
  görünümde 9 cihaz pikselinin altında çizilemez; varsayılan görünümlerle tasarım metni en az 18 px'tir (1280×720'de 9,
  1366×768'de 9,6 cihaz pikseli) ve kit'in en küçük stilleri (caption 20/28, label 20/24) kit'in 4 px ızgarasında bu
  sınırdadır. Metni bir dönüşümle de bunun altına küçültme. Lint U-FONT-004 böyle bir metni reddeder. Metin kendi elemanında durur. Satırlarında kalması gereken bir etiket
  `white-space: nowrap` kullanır (satırları `<br>`'leridir); her çeviride aynı satır sayısını koru ki Unity'de tam
  yüksekliğini alsın.
- **Görünen her metnin bir anahtarı vardır.** Metni referans dilde (RULES.md'nin adını verdiği dil: profilin **Reference
  Locale** ayarı, proje başka bir dil seçmediyse İngilizce) yaz; `data-l10n="club.overview.title"`
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
  Bir raster görseli bildirilen en büyük çözünürlük için dışa aktar (3840×2160 ile CSS boyutunun 1,5 katı) ve ona CSS
  boyutunu ver (`<img>` genişliği ve yüksekliği, `background-size`): pikselinden büyük çizilen bir resmi tarayıcı ve
  Unity farklı örnekler (lint W-IMG-001 uyarır). Aynı resim 1280×720'de o piksellerin üçte biriyle çizilir ve UI Toolkit
  bir dokunun mipmap'siz tam boy seviyesini örnekler; bu yüzden ince raster ayrıntı (kıl çizgi, bir fotoğraftaki küçük
  yazı) varsayılan çözünürlüklerin 3 katlık aralığında tarayıcıdaki gibi korunmaz: böyle ayrıntıyı vektör olarak (satır
  içi `<svg>`) çiz ya da raster resmin ayrıntısını en küçük çözünürlüğe yetecek kadar kaba tut. (Çözünürlük başına resim
  çeşitleri ileride eklenebilecek bir özelliktir; şu an yoktur.)
- **Hareket.** Transform'ların (`translate`, `rotate`, `scale`), `opacity`'nin, renklerin ve köşe yarıçaplarının
  geçişleri ve `@keyframes` animasyonları; tetikleyici ekranın açılması, bir durum, bir etkileşim durumu ya da bir
  `is-*` sınıfıdır. Boyut ya da konum değişimi `width` ya da `top` ile değil, `translate` ya da `scale` ile yapılır.
- **Oyunun zaten çizdiği alanlar** (mevcut üst bar ya da yan menü) `data-u-external` ile işaretlenmiş yer tutuculardır:
  kutuları korunur, Unity'de hiçbir şey çizmezler ve karşılaştırmada maskelenirler.

İyi çalışan bir istek:

> Ekli design system'i kullan ve README'sindeki kurallara uy. Ekran kimliği `club.overview`, tek bir 2560×1440 artboard.
> Görünen metinleri kuralların adını verdiği referans dilde yaz; her metne İngilizce `data-l10n` anahtarı ve `data-en` İngilizce metni ekle. Her butona
> `data-u-id` ve `data-u-action` ver. Yalnız kit'in yazı stili sınıflarını (caption'dan küçüğü yok) ve token'larını kullan, yalnız flex yerleşim,
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
   `keepCaptures: true` ile çalışmanın Unity görüntüleri sonuç yazıldıktan sonra `<ekran-id>/.design-ui/kept-captures/`
   içinde kalır (yakalama klasörünün tamamı: PNG'ler, `boxes.json`, `boxes.meta.json`); bir hata yeni bir Unity çalışması
   olmadan yeniden karşılaştırılabilir: `design-export compare <ekran-id>/.design-ui/export --unity
   <ekran-id>/.design-ui/kept-captures --report <dosya.html>`. `cacheBudgetMB` sınırına sayılırlar; sonraki doğrulama
   (bir sonuç verdiğinde), ekranı yeniden dışa aktaran bir içe aktarma ve `design_ui_clean` onları siler. Ekranın dışa
   aktarımı dışa aktarıcının başka bir sürümüyle yapıldıysa doğrulama yakalama yapmaz ve sonuç vermez (altın görüntülerde
   karşılaştırmanın okuduğu kayıtlar eksik olabilir): ekranı yeniden içe aktarın (bu sürümle yeniden dışa aktarır), sonra
   doğrulayın.

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
`EscapePressed`, `FocusEntered` ve `FocusLeft` bilgisini verir. Linear renk uzayındaki bir projede aynı PanelSettings ile
`DesignUiGammaComposite` ekle (örneğin ekranın GameObject'ine): ekran o zaman UI Toolkit'in bir paneli çizdiği yerde
çizilir; sıralaması daha düşük **ya da aynı** olan Screen Space - Overlay canvas'larının üstünde, daha yüksek olanların
altında (aynı sıralamadaki panellerde sonra yapılan üstte) ve fare/dokunma girdisi de bu sırayı izler. Ekranı örtmesi
gereken bir menünün sıralaması region'ınkinden yüksek olmalı. Composite yoksa region bir kez uyarır.

**Ölçekli ya da bildirilmemiş bir çözünürlükte** (1600×900, 1366×768 ya da profilin bildirmediği herhangi biri) bir
tasarım ekranı panelini bir üstteki tam ölçekte yerleştirir ve kökünü ölçekli çizer (README, Viewports). Oyun için üç sonucu
vardır:

- Bir ekran paneldeyken PanelSettings'inin `scale` değeri tam ölçeğin çarpanını okur (tam / gerçek × oyunun kendi
  çarpanı) ve o PanelSettings'in `Instantiate` kopyası bu değeri alır. Oyunun kendi çarpanını her zamanki gibi yaz:
  yazdığın değer kök ölçeğinin üstüne uygulandığı taban olur (onu bir ekran gösterilmeden önce oku ya da kendi kopyanı
  tut). Daha önce tutulmuş bir çarpana eşit bir değer de senindir (yalnız ekranın son yazdığı çarpan onundur).
- Çarpanın tutulduğu yer. Oyuncuda ve Play modunda her PanelSettings'te: Editor'de kayıt, tutulan bir varlığı kendi
  çarpanıyla yazar, bir oyuncu (player) build'i önce her tutulan çarpanı geri verir (uyarıyla), Undo anlık görüntünün
  kendi çarpanını geri getirir (script yeniden yüklendikten sonra da; yalnız dokunduğu ayarlarda ve oyunun ya da senin
  verdiğin bir değere asla), Play'den çıkış, script yeniden yükleme ve çıkış her çarpanı geri verir. Play modunda
  korunmayanlar: Scriptable Build Pipeline ya da Addressables içerik build'i (Unity'nin kendi
  `BuildPipeline.BuildAssetBundles`'ı Play modunda çalışmaz; ötekiler tutulan bir varlığın çarpanını yazar: içeriği Play
  dışında build et) ve bir ekran çarpanı tutarken kaydedilen bir preset ya da kopyalanan bir varlık (`Instantiate` +
  `CreateAsset`) çarpanı taşır. Editor'de Play dışında yalnız hiçbir kaydın yazmadığı PanelSettings'te (`HideFlags.DontSaveInEditor`: yakalamanın
  ve bir bölgenin kopyası gibi çalışma zamanı kopyaları); bir PanelSettings varlığındaki ya da sahnenin kendi
  ayarlarındaki ekran orada kök ölçeği olmadan gerçek ölçekte yerleşir, yani ölçekli bir çözünürlükte Edit modundaki
  Game görünümü oyunun yerleşimi değildir (Play'e gir ya da verify çalıştır).
- Aynı PanelSettings üzerindeki her doküman tam ölçekte yerleşir; bu yüzden onun üzerindeki tasarım ekranı olmayan UI
  daha büyük çizilir: 1600×900'de %20 (0,75 / 0,625), 1366×768'de %41 (0,75 / 0,5335). Tasarım ekranlarına kendi
  PanelSettings'lerini (profilinkini) ver.
- Ekran kökünün satır içi `translate`, `rotate`, `scale` ve `transform-origin` değerleri, kök ölçeğiyle birleşmiş
  tasarım dönüşümüdür (ve kökün tasarım animasyonları): oyun kodunun ekran köküne yazdığı değerlerin üzerine yazılır.
  Ekranı taşımak, ölçeklemek ya da canlandırmak için onu saran bir öğeyi kullan.
- Ekran kökünün dışındaki panel koordinatları tam ölçeğin birimindedir: `RuntimePanelUtils.ScreenToPanel`, ekranın
  çevresindeki bir kabın padding'i ve hizalaması. Ekranı ortalayan bir kap (`align-items: center`) 1600×900'de 2560 px'lik
  yerleşim kutusunu 2133 px'lik panelde ortalar ve ekranı −160 cihaz pikseli kaydırır. Ekranı, artboard gibi, kabının
  sol üst köşesine koy.

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
aktar; bölgenin `TextSizes` alanına `IDesignTextSizeSource` uygulayan bir bileşen ver (oyunun ayarı). ×1'in altındaki bir
seçenek metni okunabilir sınırın (9 cihaz pikseli) altına çizebilir; bu oyuncunun seçimidir, bu yüzden kit eşitleme
seçenekleri kit.config.json'a yazar ve `kit build` böyle bir seçenek için uyarır (varsayılan kit'le seçenekleri ×0,9 ve
üstünde tut: 1280×720'de 9 cihaz pikseli). Paketin varsayılan bir seçeneği yoktur.

**Hareket.** Animasyonlar kendiliğinden oynar. Bir erişilebilirlik ayarı için
`if (DesignUiAnimationPlayer.For(view.Root) is { } motion) motion.ReducedMotion = true;` yaz (animasyonu olmayan
ekranın oynatıcısı yoktur): geçişler sona atlar, animasyonlar duran karelerini gösterir.

## Doğrulama görüntüleri

`design_ui_verify` açık editörünü hiçbir zaman kullanmaz. `design-ui.config.json` içindeki
`unityRunner.command.capture` komutunu çalıştırır; bu komut projenin bir **kopyasında** çizer (Unity aynı projeyi iki kez
açamaz). Deponun `scripts/capture-on-copy.sh` betiği bunu yapar ve `scripts/setup.sh` onu yeni bir ayar dosyasına yazar:

```json
"unityRunner": {
  "prefer": "editor",
  "captureVia": "command",
  "timeoutSec": 3600,
  "command": { "import": [], "kitSync": [], "capture": ["<klon>/scripts/capture-on-copy.sh", "{projectDir}"] }
}
```

Betik bir yakalama yuvası bekler (varsayılan olarak makinede aynı anda tek bir capture-on-copy Unity'si), kopyanın
gideceği diskte yer olup olmadığına bakar, projeyi geçici bir klasöre kopyalar (macOS'ta APFS klonu: `Library` bedavaya
gelir; başka sistemlerde rsync), açık editörün süreç ve kilit dosyalarını kopyadan siler (`Library/ilpp.pid` ve
`Library` içindeki her `*.pid`, `Library/EditorInstance.json`, varlık veritabanlarının `-lock` dosyaları, arama dizini
kilitleri, paketlerin `.lock` ve `*.lock` dosyaları, `UnityLockfile` ile birlikte `Temp/`: `ilpp.pid`'i taşıyan bir kopyanın Unity'si **açık** editörün IL
post-processing sürecini durdurur), paketin testlerini (`"testables"`) yalnız **kopyanın** `Packages/manifest.json`
dosyasına yazar, EditMode testi `DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv`'i orada batchmode'da
çalıştırır ve Unity bitince, yakalama başarılı da olsa başarısız da olsa kopyayı siler ve yuvayı bırakır. Sunucu onu
`unityRunner.timeoutSec` dolunca durdurduğunda (SIGTERM, iki saniye sonra SIGKILL) ya da Ctrl-C ile durdurulduğunda önce
kendi Unity'sini ve Unity'nin başlattığı her şeyi durdurup bekler, sonra yuvayı bırakır ve kopyayı arka planda siler;
durdurulan bir yakalamanın Unity'si sonraki yakalamanın yanında çalışmaya devam etmez. Senin projenin manifest'i paketin testlerini hiçbir zaman listelemez
(listeleseydi, proje ayarlarını değiştiren paket testleri senin Test Runner'ına girerdi) ve projene hiçbir sahne, varlık
ya da yardımcı dosya eklenmez. Sunucu dışa aktarım ve çıktı klasörlerini ortam değişkenleriyle verir
(`DESIGN_UI_EXPORT_DIR`, `DESIGN_UI_OUT_DIR`; `{exportDir}` ve `{outDir}` yer tutucuları olarak da); Unity, Unity Hub'daki
proje sürümüdür ya da `UNITY_BIN`. Sunucu, komutun `PATH`'inin başına kendi çalıştığı node'un klasörünü koyar ve
`DESIGN_UI_NODE` ile o node'u adlandırır (betik node çalıştırır; bir istemci sunucuyu node'suz bir `PATH` ile başlatabilir).
Kendi betiğin de aynı biçimde çalışır, yeter ki ardını temizlesin. Windows'ta varsayılan yol yoktur (betik bash ve `rsync`
ister): WSL ya da kendi komutunu kullan.

Her yakalama ağır bir Unity işidir. Betiğin seçenekleri komut şablonuna yazılır (sunucu kendi ortamındaki `DESIGN_UI_*`
değişkenlerini aktarmaz; aynı adlı `CAPTURE_COPY_*` değişkenleri de çalışır):

| Seçenek | Değişken | Varsayılan | Ne yapar |
|---|---|---|---|
| `--slots N` | `CAPTURE_COPY_SLOTS` | 1 | makinede aynı anda çalışan capture-on-copy Unity'si; diğerleri beklediğini yazar ve bekler. Bekleme `unityRunner.timeoutSec` süresinden düşer (yakalamalar sıraya giriyorsa artır). Bir yuva, betiği ya da Unity'si çalıştığı sürece dolu sayılır (SIGKILL ile öldürülen bir betiğin Unity'si bitene kadar yuvayı tutar); ikisi de bitince devralınır. |
| `--min-free-gb N` | `CAPTURE_COPY_MIN_FREE_GB` | 10 | kopyanın gideceği yerde (`TMPDIR`) gereken boş disk; rsync'te projenin boyutu da eklenir (`du`'nun okuyabildiği kadarı; açık editörün o sırada sildiği dosyalar ya da okunamayan klasörler bildirilir, durdurmaz). Altında betik hiçbir şey kopyalamadan durur, ne kadar boş yer olduğunu söyler ve 2 ile çıkar. |
| `--lock-dir DIR` | `CAPTURE_COPY_LOCK_DIR` | `<TMPDIR>/design-ui-capture-slots` (`TMPDIR` yoksa `/tmp/design-ui-capture-slots-<uid>`) | yuvaların klasörü: onu paylaşan yakalamalar yuvaları da paylaşır. `ps`'in komut satırı göstermediği yerde (Git Bash, busybox) bir yuva, yeniden kullanılan bir süreç numarasını sahibinden ayıramaz ve dolu sayar. |

```json
"capture": ["<klon>/scripts/capture-on-copy.sh", "{projectDir}", "--slots", "1", "--min-free-gb", "20"]
```

Ağır Unity işleri için kendi çalıştırıcısı olan bir proje (makine çapında iş sınırı, yalıtılmış klonlar)
`command.capture`'a o çalıştırıcının komutunu yazar: aynı `{projectDir}`, `{exportDir}` ve `{outDir}` yer tutucularını ve
`DESIGN_UI_EXPORT_DIR` / `DESIGN_UI_OUT_DIR` değişkenlerini alır, yukarıdaki EditMode testini kendi kopyasında çalıştırır
(paketi o kopyanın `testables` listesine yazarak), `DESIGN_UI_OUT_DIR`'e yazar ve kopyasını siler.

Yakalama, çıktı klasörüne her iş için bir PNG, `boxes.json`, `boxes.meta.json` ve en son `capture-done.json` yazar;
sunucu ardından karşılaştırır ve raporu yazar. Başarısız olan, zaman aşımına uğrayan ya da bitmeyen bir çalışma, yarım
kalan görüntülerini, meta dosyasını ve Unity günlüğünü `<designRoot>/<ekran-id>/.design-ui/failed-<run>/` altında tutar
(en yeni üçünü). Komut senin yetkilerinle bir program olarak çalışır; yalnız güvendiğin ayar dosyalarını kullan.

## Disk kullanımı

Sunucu kendi dosyalarını kendisi küçük tutar: bir doğrulama raporunu yazdıktan sonra o çalışmanın Unity görüntülerini ve
fark görüntülerini siler (rapor, başarısız yakalamaların küçük görsellerini ve sorun kırpıntılarını tutar); her içe
aktarma ve doğrulamadan sonra her ekranın kayıtlarını (`<designRoot>/<ekran-id>/.design-ui/`: kayıtlar, son dışa aktarım,
son raporun görselleri, en yeni üç başarısız çalışma, istek üzerine tutulan doğrulama görüntüleri) `design-ui.config.json`
içindeki `cacheBudgetMB` sınırında tutar (varsayılan 2048): aşılırsa önce tutulan görüntüler, sonra en uzun süredir içe
aktarılmamış ya da doğrulanmamış ekranların dışa aktarımları gider, sonraki içe aktarma ya da doğrulama onları yeniden
üretir (bir doğrulamanın az önce tuttuğu görüntüleri o doğrulamanın kendi temizliği asla silmez; bütçe aşılınca sonraki
bir temizlik silebilir, kayıt ve rapor bunu söyler). Kayıtlar, rapor görselleri ve her ekranın en yeni üç başarısız
çalışması bütçe için asla silinmez; yalnız onlar bütçeden büyükse kayıtlar bütçenin üstünde kalabilir. Tutulan görüntüler aksi halde sonraki doğrulamaya, ekranı yeniden dışa
aktaran bir içe aktarmaya (artık altın görüntülerle eşleşmezler) ya da `design_ui_clean` çağrısına kadar kalır;
`design_ui_clean` onları her zaman siler. Kit eşitleme ve her içe aktarma, hiçbir metin stilinin, derlenmiş
ekranın ya da dil fontunun kullanmadığı font ikizlerini siler. `design_ui_status` kayıtların boyutunu ekran ekran ve toplam
olarak gösterir; `design_ui_clean` (`dryRun` ile yalnız rapor) temizliği hemen çalıştırır. Bu klasörleri, üretilmiş
dosyaları ya da font ikizlerini elle silme.

## AI istemcisi olmadan

Aynı adımlar komut satırından ve Unity'den de çalışır:

```sh
npx design-export lint <tasarım klasörü ya da sayfası> --kit <kitDir>
npx design-export export <tasarım> --kit <kitDir> --out <exportDir>
npx design-export compare <exportDir> --unity <captureDir> --report report.html
npx design-export kit build <kitDir> --check
npx design-export kit claude <kitDir> <outDir> [--all-faces]
npx design-export kit upgrade <kitDir> [--dry-run]
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
| U-FONT-004 | bildirilen bir görünümde (dönüşümleriyle, çizildiği bir durumda) 9 cihaz pikselinin altında çizilen metin | en az 18 px'lik bir yazı stili (kit'in caption ya da label'ı), küçültülmeden |
| U-CSS-019 | içeriğinin altına küçülen bir öğe | `flex-shrink: 0` ya da açık bir boyut |
| U-CSS-038 | gri tonlamalı yumuşatması olmayan metin | kit'in temel stil sayfasını koru |
| U-CSS-039 | parçaları üst üste binen elemanda 1'den küçük opacity | kit'in disabled renkleri |
| U-CSS-040 | cihaz pikseline oturmayan ince bir kenarlık ya da çizgi | listelenen uzunluklar |
| U-CSS-047 | `overflow: hidden` olan bir kutu, metninin satır kutusundan kısa (20/24 bir etiket 20 px kutuda); çizildiği ölçekte ve metnin başladığı yerden ölçülür | kutuyu en az satır yüksekliği (24 px) artı metnin üstündeki dolgu kadar yap ya da sığan bir yazı stili kullan |
| W-TEXT-001 (uyarı) | sarılan bir metinde kutusundan geniş bir kelime (tarayıcı taşırır, UI Toolkit kelimenin içinden böler) | en uzun kelimeye (çevirilerde de) yer aç, ya da `white-space: nowrap` ve üç nokta |
| U-CSS-046 | cihaz pikseline oturmayan bir padding, margin ya da gap (10 px, 1920×1080'de 7,5 cihaz pikseli) | bulgunun söylediği en yakın uzunluklar, 4 px'in katları |
| W-IMG-001 (uyarı) | bildirilen bir çözünürlükte pikselinden büyük çizilen bir raster görsel | bulgunun söylediği boyutta (CSS boyutu × en büyük çözünürlüğün ölçeği) dışa aktar ve o CSS boyutunu ver |
| U-CSS-013, U-CSS-042 | yerleşim özelliğinin animasyonu | `translate` ya da `scale` |
| U-MRK-003 | `data-u-id`'si olmayan kontrol, bağlı ya da aksiyonlu eleman | bir kimlik ekle |
| U-MRK-004 | `data-l10n` ve `data-en`'i olmayan görünür metin | anahtarı ve İngilizce metni ekle |
| U-MRK-005 | izin verilmeyen karakterli kimlik ya da anahtar (`İ`, `ı`, `ş`, rakamla başlama) | ASCII karşılığı |
| U-MRK-013 | kendi işaretlemesiyle gizlenmiş örnek satır | o satırı hiç yazma |
| U-FONT-001 | fontta gerçek yüzü olmayan kalınlık ya da italik | 400 ya da 700, ya da yüzü Unity'de ekleyip kit'i senkronla |
| U-FONT-003 | kit fontunda olmayan bir karakter | fontun kapsadığı karakterler ya da onları içeren bir font |

Her düzeltmesiyle tam liste [RULES.md](../../design-kit/RULES.md#lint-rules) dosyasındadır. Lint dışındaki sorunlar
için README'deki [sorun giderme](../../README.md#troubleshooting) tablosuna bak.
